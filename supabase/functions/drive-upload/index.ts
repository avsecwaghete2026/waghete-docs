// drive-upload: admin-only. Receives multipart/form-data from the
// browser (file + title + category_id + tags), uploads the bytes to
// Google Drive via OAuth, then writes a row into the documents table.
//
// Why multipart and not JSON? Multipart is the only sane way to send a
// file + structured fields together from the browser without base64
// bloat.

import { uploadToDrive, renameFileInDrive } from '../_shared/google.ts';
import { authenticate, corsHeaders, json, preflight } from '../_shared/auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  const auth = await authenticate(req, /* requireAdmin */ true);
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  // Parse multipart form data. We use the Web FormData parser (built
  // into Deno) which handles files natively.
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return json({ error: 'invalid_multipart', detail: String(e) }, 400, origin);
  }

  const file = form.get('file');
  const title = (form.get('title') as string | null)?.trim() ?? '';
  const categoryId = (form.get('category_id') as string | null) ?? '';
  const tagsRaw = (form.get('tags') as string | null) ?? '';
  // When replacing the file on an existing row, the frontend passes the
  // row's id so we update in place instead of inserting a duplicate.
  const documentId = (form.get('document_id') as string | null)?.trim() ?? '';

  if (!(file instanceof File)) {
    return json({ error: 'file_required' }, 400, origin);
  }
  if (!title) {
    return json({ error: 'title_required' }, 400, origin);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: 'file_too_large', max: MAX_BYTES }, 400, origin);
  }

  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  // 1. Upload to Drive.
  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let driveFileId: string;
  try {
    driveFileId = await uploadToDrive(bytes, {
      name: file.name || title,
      mimeType: file.type || 'application/octet-stream',
    });
  } catch (e) {
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
        file_type: file.type || null,
        file_size: file.size,
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
        file_type: file.type || null,
        file_size: file.size,
      })
      .select()
      .single();
    row = res.data;
    rowErr = res.error;
  }

  if (rowErr || !row) {
    // Best-effort cleanup; failure here is logged but doesn't override
    // the user-facing error.
    const { deleteFromDrive } = await import('../_shared/google.ts');
    await deleteFromDrive(driveFileId).catch(() => {});
    return json({ error: 'db_persist_failed', detail: rowErr?.message ?? 'unknown' }, 500, origin);
  }

  return json({ ok: true, document: row }, 200, origin);
});

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}