// drive-upload: admin-only.
//
// Receives the file as the RAW request body, not multipart/form-data.
// Metadata is supplied through query-string parameters.
//
// Browser:
//   POST /drive-upload?title=...&filename=...&size=...
//   Body = raw File
//
// Edge Function:
//   req.body -> Google Drive resumable upload
//
// The file is never loaded entirely into Edge Function memory.

import {
  uploadToDriveResumable,
  renameFileInDrive,
  deleteFromDrive,
} from "../_shared/google.ts";

import {
  authenticate,
  json,
  preflight,
} from "../_shared/auth.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 250 MiB
const MAX_BYTES = 250 * 1024 * 1024;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return preflight(origin);
  }

  if (req.method !== "POST") {
    return json(
      { error: "method_not_allowed" },
      405,
      origin,
    );
  }

  // ------------------------------------------------------------
  // Authentication
  // ------------------------------------------------------------

  const auth = await authenticate(req, true);

  if ("error" in auth) {
    return auth.error;
  }

  const { caller } = auth;

  // ------------------------------------------------------------
  // Read metadata from query parameters
  // ------------------------------------------------------------

  const url = new URL(req.url);

  const title =
    url.searchParams.get("title")?.trim() ?? "";

  const categoryId =
    url.searchParams.get("category_id") ?? "";

  const tagsRaw =
    url.searchParams.get("tags") ?? "";

  const isConfidentialRaw =
    url.searchParams.get("is_confidential") ?? "";

  const filename =
    url.searchParams.get("filename")?.trim() ??
    title;

  const documentId =
    url.searchParams.get("document_id")?.trim() ?? "";

  // The browser already knows the File.size, so we send it
  // explicitly as metadata.
  const sizeParam =
    url.searchParams.get("size");

  const declaredSize =
    sizeParam !== null
      ? Number(sizeParam)
      : Number(req.headers.get("Content-Length"));

  // ------------------------------------------------------------
  // Validate metadata
  // ------------------------------------------------------------

  if (!title) {
    return json(
      { error: "title_required" },
      400,
      origin,
    );
  }

  if (!filename) {
    return json(
      { error: "filename_required" },
      400,
      origin,
    );
  }

  if (!Number.isFinite(declaredSize)) {
    return json(
      { error: "content_length_required" },
      400,
      origin,
    );
  }

  if (declaredSize < 0) {
    return json(
      { error: "invalid_content_length" },
      400,
      origin,
    );
  }

  if (declaredSize > MAX_BYTES) {
    return json(
      {
        error: "file_too_large",
        max: MAX_BYTES,
      },
      400,
      origin,
    );
  }

  if (!req.body) {
    return json(
      { error: "file_required" },
      400,
      origin,
    );
  }

  // ------------------------------------------------------------
  // MIME type
  // ------------------------------------------------------------

  const mimeType =
    req.headers.get("Content-Type") ||
    "application/octet-stream";

  // ------------------------------------------------------------
  // Tags
  // ------------------------------------------------------------

  const tags = tagsRaw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const isConfidential =
    isConfidentialRaw === "true";

  // ------------------------------------------------------------
  // Count bytes while streaming
  //
  // This protects us from a malicious/mistaken size parameter.
  // The file is NEVER buffered into memory.
  // ------------------------------------------------------------

  let bytesSeen = 0;

  const limitedBody =
    req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesSeen += chunk.byteLength;

          if (bytesSeen > MAX_BYTES) {
            controller.error(
              new Error("File exceeds 250 MiB limit."),
            );
            return;
          }

          controller.enqueue(chunk);
        },

        flush() {
          if (bytesSeen !== declaredSize) {
            throw new Error(
              `Uploaded byte count (${bytesSeen}) does not match declared size (${declaredSize}).`,
            );
          }
        },
      }),
    );

  // ------------------------------------------------------------
  // Upload to Google Drive
  // ------------------------------------------------------------

  let driveFileId: string;

  try {
    driveFileId = await uploadToDriveResumable(
      limitedBody,
      {
        name: filename,
        mimeType,
        size: declaredSize,
      },
    );
  } catch (e) {
    console.error(
      "[drive-upload] Google Drive upload failed:",
      e,
    );

    return json(
      {
        error: "drive_upload_failed",
        detail: String(e),
      },
      502,
      origin,
    );
  }

  // ------------------------------------------------------------
  // Supabase admin client
  // ------------------------------------------------------------

  const admin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  let row: any;
  let rowErr: any;

  // ------------------------------------------------------------
  // Replace existing document
  // ------------------------------------------------------------

  if (documentId) {
    const {
      data: existing,
      error: existingErr,
    } = await admin
      .from("documents")
      .select(
        "id, title, drive_file_id, deleted_at",
      )
      .eq("id", documentId)
      .single();

    if (
      existingErr ||
      !existing ||
      existing.deleted_at
    ) {
      // The new file was already uploaded to Drive.
      // Clean it up because the database row doesn't exist.
      await deleteFromDrive(driveFileId).catch(() => {});

      return json(
        { error: "not_found" },
        404,
        origin,
      );
    }

    const res = await admin
      .from("documents")
      .update({
        title,
        category_id: categoryId || null,
        tags,
        drive_file_id: driveFileId,
        file_type: mimeType,
        file_size: declaredSize,
        is_confidential: isConfidential,
      })
      .eq("id", documentId)
      .select()
      .single();

    row = res.data;
    rowErr = res.error;

    // Rename the previous Drive file.
    if (
      !rowErr &&
      existing.drive_file_id &&
      existing.drive_file_id !== driveFileId
    ) {
      const ts = formatDate(new Date());

      const newName =
        `${existing.title} (replaced at ${ts})`;

      try {
        await renameFileInDrive(
          existing.drive_file_id,
          newName,
        );
      } catch (e: any) {
        if (e?.message?.includes("404")) {
          console.warn(
            "[drive-upload] Old Drive file already gone.",
          );
        } else {
          console.warn(
            "[drive-upload] Failed to rename old Drive file:",
            e,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------
  // New document
  // ------------------------------------------------------------

  else {
    const res = await admin
      .from("documents")
      .insert({
        title,
        category_id: categoryId || null,
        tags,
        uploaded_by: caller.id,
        drive_file_id: driveFileId,
        file_type: mimeType,
        file_size: declaredSize,
        is_confidential: isConfidential,
      })
      .select()
      .single();

    row = res.data;
    rowErr = res.error;
  }

  // ------------------------------------------------------------
  // Database failure
  // ------------------------------------------------------------

  if (rowErr || !row) {
    console.error(
      "[drive-upload] Database persist failed:",
      rowErr,
    );

    // Remove orphaned Drive file.
    await deleteFromDrive(driveFileId).catch(() => {});

    return json(
      {
        error: "db_persist_failed",
        detail:
          rowErr?.message ??
          "unknown",
      },
      500,
      origin,
    );
  }

  // ------------------------------------------------------------
  // Success
  // ------------------------------------------------------------

  return json(
    {
      ok: true,
      document: row,
      bytes: bytesSeen,
    },
    200,
    origin,
  );
});

function formatDate(d: Date): string {
  const pad = (n: number) =>
    String(n).padStart(2, "0");

  return (
    `${d.getFullYear()}-` +
    `${pad(d.getMonth() + 1)}-` +
    `${pad(d.getDate())} ` +
    `${pad(d.getHours())}:` +
    `${pad(d.getMinutes())}`
  );
}