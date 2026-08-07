// drive-upload: admin-only. Receives multipart/form-data from the
// browser (file + title + category_id + tags), uploads the bytes to
// Google Drive via OAuth, then writes a row into the documents table.
//
// Why multipart and not JSON? Multipart is the only sane way to send a
// file + structured fields together from the browser without base64
// bloat.

import { uploadToDrive } from '../_shared/google.ts';
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

  // 2. Insert the metadata row. If the insert fails we try to clean up
  //    the orphan Drive file.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: row, error: rowErr } = await admin
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

  if (rowErr || !row) {
    // Best-effort cleanup; failure here is logged but doesn't override
    // the user-facing error.
    const { deleteFromDrive } = await import('../_shared/google.ts');
    await deleteFromDrive(driveFileId).catch(() => {});
    return json({ error: 'db_insert_failed', detail: rowErr?.message ?? 'unknown' }, 500, origin);
  }

  return json({ ok: true, document: row }, 200, origin);
});