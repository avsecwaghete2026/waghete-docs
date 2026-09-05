// drive-upload: admin-only. Receives the raw file bytes as the request
// body (metadata travels via the query string instead of multipart
// fields) and streams them straight through to Google Drive via a
// resumable upload session, then writes a row into the documents table.
//
// Why not multipart/form-data anymore? A multipart body has to be
// fully parsed — and the old implementation additionally base64-encoded
// the whole file for Drive's `multipart` upload type — before a single
// byte reaches Drive. For files up to a few hundred MB that blows past
// this function's 256MB memory ceiling and its per-request CPU-time
// budget. Streaming the raw body straight into a Drive *resumable*
// upload session keeps memory use roughly constant no matter the file
// size.

import { uploadToDriveResumable, renameFileInDrive, deleteFromDrive } from '../_shared/google.ts';
import { authenticate, corsHeaders, json, preflight } from '../_shared/auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_BYTES = 250 * 1024 * 1024; // 250 MiB

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  const auth = await authenticate(req, /* requireAdmin */ true);
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  // Metadata now travels via the query string — the body is nothing
  // but the raw file bytes.
  const url = new URL(req.url);
  const title = (url.searchParams.get('title') ?? '').trim();
  const categoryId = url.searchParams.get('category_id') ?? '';
  const tagsRaw = url.searchParams.get('tags') ?? '';
  const isConfidentialRaw = url.searchParams.get('is_confidential') ?? '';
  // When replacing the file on an existing row, the frontend passes the
  // row's id so we update in place instead of inserting a duplicate.
  const documentId = (url.searchParams.get('document_id') ?? '').trim();
  const filename = (url.searchParams.get('filename') ?? '').trim();

  if (!title) {
    return json({ error: 'title_required' }, 400, origin);
  }
  if (!filename) {
    return json({ error: 'filename_required' }, 400, origin);
  }
  if (!req.body) {
    return json({ error: 'file_required' }, 400, origin);
  }

  const clientMimeType = req.headers.get('Content-Type');
  const mimeType = clientMimeType || 'application/octet-stream';

  // We rely on Content-Length to open a single-shot resumable upload
  // (see uploadToDriveResumable) — browsers always send this for a
  // File/Blob request body, so its absence means something unexpected
  // sent the request.
  const contentLengthHeader = req.headers.get('Content-Length');
  const declaredSize = contentLengthHeader ? Number(contentLengthHeader) : null;
  if (declaredSize == null || Number.isNaN(declaredSize)) {
    return json({ error: 'content_length_required' }, 400, origin);
  }
  if (declaredSize > MAX_BYTES) {
    return json({ error: 'file_too_large', max: MAX_BYTES }, 400, origin);
  }

  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const isConfidential = isConfidentialRaw === 'true';

  // Belt-and-suspenders: enforce MAX_BYTES on the bytes actually read,
  // not just the client-declared Content-Length, without ever buffering
  // the file ourselves — this just counts bytes as they pass through.
  let bytesSeen = 0;
  let limitExceeded = false;
  const limitedBody = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesSeen += chunk.byteLength;
        if (bytesSeen > MAX_BYTES) {
          limitExceeded = true;
          controller.error(new Error('file_too_large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  // 1. Stream the upload straight to Drive.
  let driveFileId: string;
  try {
    driveFileId = await uploadToDriveResumable(limitedBody, {
      name: filename,
      mimeType,
      size: declaredSize,
    });
  } catch (e) {
    if (limitExceeded) {
      return json({ error: 'file_too_large', max: MAX_BYTES }, 400, origin);
    }
    return json({ error: 'drive_upload_failed', detail: String(e) }, 502, origin);
  }

  // 2. Persist the row. If `document_id` was supplied we UPDATE in place
  //    (file replacement); otherwise we INSERT a new row (initial upload).
  //    We must update the existing row's drive_file_id atomically so no
  //    duplicate row is created.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let row: any;
  let rowErr: any;

  if (documentId) {
    // Fetch the existing row to get title + old drive_file_id for the rename.
    const { data: existing, error: existingErr } = await admin
      .from('documents')
      .select('id, title, drive_file_id, deleted_at')
      .eq('id', documentId)
      .single();
    if (existingErr || !existing || existing.deleted_at) {
      return json({ error: 'not_found' }, 404, origin);
    }

    const res = await admin
      .from('documents')
      .update({
        title,
        category_id: categoryId || null,
        tags,
        drive_file_id: driveFileId,
        file_type: clientMimeType || null,
        file_size: declaredSize,
        is_confidential: isConfidential,
      })
      .eq('id', documentId)
      .select()
      .single();
    row = res.data;
    rowErr = res.error;

    // Rename the old Drive file — only if the update succeeded and there was
    // a previous file to rename.
    if (!rowErr && existing.drive_file_id && existing.drive_file_id !== driveFileId) {
      const ts = formatDate(new Date());
      const newName = `${existing.title} (replaced at ${ts})`;
      try {
        await renameFileInDrive(existing.drive_file_id, newName);
      } catch (e: any) {
        if (e?.message?.includes('404')) {
          // Old file already gone from Drive — nothing to rename, skip silently.
          console.warn('[drive-upload] Old Drive file not found (already deleted), skipping rename.', {
            drive_file_id: existing.drive_file_id,
            error: e?.message,
          });
        } else {
          console.warn('[drive-upload] Failed to rename old Drive file:', e);
        }
      }
    }
  } else {
    const res = await admin
      .from('documents')
      .insert({
        title,
        category_id: categoryId || null,
        tags,
        uploaded_by: caller.id,
        drive_file_id: driveFileId,
        file_type: clientMimeType || null,
        file_size: declaredSize,
        is_confidential: isConfidential,
      })
      .select()
      .single();
    row = res.data;
    rowErr = res.error;
  }

  if (rowErr || !row) {
    // Best-effort cleanup; failure here is logged but doesn't override
    // the user-facing error.
    await deleteFromDrive(driveFileId).catch(() => {});
    return json({ error: 'db_persist_failed', detail: rowErr?.message ?? 'unknown' }, 500, origin);
  }

  return json({ ok: true, document: row }, 200, origin);
});

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}