// drive-download: any authenticated user. Streams the file bytes from
// Google Drive to the browser. We use this for both inline previews
// (PDF.js + <img>) and direct downloads.
//
// The browser asks the Edge Function for the bytes; the function
// authenticates the caller, then streams the Drive response through
// itself. Drive's URL is never exposed.

import { downloadFromDrive } from '../_shared/google.ts';
import { authenticate, preflight } from '../_shared/auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin ?? 'https://waghete-docs.pages.dev',
      'Vary': 'Origin',
    },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  const auth = await authenticate(req, /* requireAdmin */ false);
  if ('error' in auth) return auth.error;

  // Parse the file id from query string.
  const url = new URL(req.url);
  const fileId = url.searchParams.get('id');
  if (!fileId) {
    return json({ error: 'id_required' }, 400, origin);
  }

  // Verify the file exists in the documents table. Defense in depth:
  // even if someone bypassed RLS, they still need a real id here.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: row, error: rowErr } = await admin
    .from('documents')
    .select('id, title, drive_file_id, deleted_at')
    .eq('drive_file_id', fileId)
    .maybeSingle();

  if (rowErr || !row) {
    return json({ error: 'not_found' }, 404, origin);
  }
  if (row.deleted_at) {
    return json({ error: 'not_found' }, 404, origin);
  }

  // Fetch + stream.
  let driveRes: { body: ReadableStream; contentType: string; contentLength: string | null };
  try {
    driveRes = await downloadFromDrive(fileId);
  } catch (e) {
    return json({ error: 'drive_download_failed', detail: String(e) }, 502, origin);
  }

  const allowOrigin = (() => {
    if (!origin) return 'https://waghete-docs.pages.dev';
    if (origin.endsWith('.pages.dev')) return origin;
    if (origin === 'https://waghete-docs.pages.dev') return origin;
    return 'https://waghete-docs.pages.dev';
  })();

  const headers: HeadersInit = {
    'Content-Type': driveRes.contentType,
    'Cache-Control': 'private, max-age=300',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
    ...(driveRes.contentLength ? { 'Content-Length': driveRes.contentLength } : {}),
  };

  return new Response(driveRes.body, { status: 200, headers });
});
