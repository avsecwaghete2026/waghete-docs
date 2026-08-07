// drive-delete: admin-only. Removes the document row and the
// underlying Drive file. Accepts the document id (not the Drive file
// id) so the caller never has to know Drive's internals.

import { deleteFromDrive } from '../_shared/google.ts';
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

  // Fetch the Drive file id first.
  const { data: row, error: fetchErr } = await admin
    .from('documents')
    .select('drive_file_id')
    .eq('id', id)
    .single();
  if (fetchErr || !row) {
    return json({ error: 'not_found' }, 404, origin);
  }

  // Delete the row first; if it fails we leave Drive alone. If row
  // deletion succeeds but Drive deletion fails, we still return
  // success — orphan files can be cleaned up later.
  const { error: delErr } = await admin.from('documents').delete().eq('id', id);
  if (delErr) {
    return json({ error: 'db_delete_failed', detail: delErr.message }, 500, origin);
  }

  await deleteFromDrive(row.drive_file_id).catch((e) => {
    console.warn('Drive delete failed (orphan left in Drive):', e);
  });

  return json({ ok: true }, 200, origin);
});