// drive-delete: admin-only. Soft-deletes the document row (sets deleted_at)
// and renames the Drive file to "[name] (deleted at YYYY-MM-DD HH:mm)" instead
// of actually deleting it — so it can be recovered if needed.

import { renameFileInDrive } from '../_shared/google.ts';
import { authenticate, json, preflight } from '../_shared/auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  const auth = await authenticate(req, /* requireAdmin */ true);
  if ('error' in auth) return auth.error;

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, origin);
  }
  const id = body.id;
  if (!id) return json({ error: 'id_required' }, 400, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fetch the row first — we need title + drive_file_id for the rename.
  const { data: row, error: fetchErr } = await admin
    .from('documents')
    .select('id, title, drive_file_id, deleted_at')
    .eq('id', id)
    .single();
  if (fetchErr || !row) {
    return json({ error: 'not_found' }, 404, origin);
  }
  // Already soft-deleted — nothing to do.
  if (row.deleted_at) {
    return json({ ok: true, already_deleted: true }, 200, origin);
  }

  const deletedAt = new Date();
  const newDriveName = `${row.title} (deleted at ${formatDate(deletedAt)})`;

  // 1. Mark the row as deleted (soft delete).
  const { error: updateErr } = await admin
    .from('documents')
    .update({ deleted_at: deletedAt.toISOString() })
    .eq('id', id);
  if (updateErr) {
    return json({ error: 'db_update_failed', detail: updateErr.message }, 500, origin);
  }

  // 2. Rename the Drive file instead of deleting it.
  //    Best-effort — 404 means the file is already gone (skip silently).
  if (row.drive_file_id) {
    try {
      await renameFileInDrive(row.drive_file_id, newDriveName);
    } catch (e: any) {
      if (e?.message?.includes('404')) {
        console.warn('[drive-delete] Old Drive file not found (already gone), skipping rename.');
      } else {
        console.warn('Drive rename failed (file may still be live):', e);
      }
    }
  }

  return json({ ok: true, deleted_at: deletedAt.toISOString() }, 200, origin);
});

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}