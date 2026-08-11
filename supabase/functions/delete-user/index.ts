// Supabase Edge Function: delete-user
//
// Called by the admin panel when an admin removes a user. We MUST run
// server-side because deleting an auth user requires the service_role
// key — which never leaves the server.
//
// Deploy:   supabase functions deploy delete-user --no-verify-jwt
// Secret:   SUPABASE_SERVICE_ROLE_KEY  (auto-injected; do not redeclare)
//
// Auth: the caller's JWT is in the Authorization header. We verify it
// by calling supabase.auth.getUser(jwt) against the project's anon key,
// then check the profiles table to confirm role='admin'.
// Self-delete is blocked: an admin cannot remove their own account.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://waghete-docs.pages.dev',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);

function corsHeaders(origin: string | null): HeadersInit {
  const allowOrigin =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://waghete-docs.pages.dev';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  // 1. Authenticate the caller.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'unauthenticated' }, 401, origin);

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: caller, error: callerErr } = await anon.auth.getUser(jwt);
  if (callerErr || !caller?.user) return json({ error: 'unauthenticated' }, 401, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', caller.user.id)
    .single();

  if (profileErr || profile?.role !== 'admin') {
    return json({ error: 'forbidden' }, 403, origin);
  }

  // 2. Parse + validate the request body.
  let body: { user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, origin);
  }

  const userId = (body.user_id ?? '').trim();
  if (!userId) return json({ error: 'missing_user_id' }, 400, origin);

  // Block self-delete — an admin shouldn't be able to lock themselves out.
  if (userId === caller.user.id) {
    return json({ error: 'cannot_delete_self' }, 400, origin);
  }

  // 3. Look up the target profile so we can return a useful error if they
  //    don't exist (and to surface their email in the success payload).
  const { data: target, error: targetErr } = await admin
    .from('profiles')
    .select('id, email')
    .eq('id', userId)
    .single();

  if (targetErr || !target) {
    return json({ error: 'user_not_found' }, 404, origin);
  }

  // 4. Delete the auth user. The profiles row cascades via the FK
  //    "on delete cascade" declared in 0001_schema.sql.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteErr) {
    return json({ error: deleteErr.message }, 500, origin);
  }

  return json({ ok: true, user: { id: target.id, email: target.email } }, 200, origin);
});
