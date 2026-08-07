// Supabase Edge Function: create-user
//
// Called by the admin panel when an admin creates a new account.
// We MUST run server-side because creating an auth user requires the
// service_role key — which never leaves the server.
//
// Deploy:   supabase functions deploy create-user --no-verify-jwt
// Secret:   SUPABASE_SERVICE_ROLE_KEY  (auto-injected; do not redeclare)
//
// Auth: the caller's JWT is in the Authorization header. We verify it
// by calling supabase.auth.getUser(jwt) against the project's anon key,
// then check the profiles table to confirm role='admin'.
//
// CORS: Edge Functions don't auto-handle preflight. We handle OPTIONS
// explicitly so the browser's preflight succeeds against
// https://waghete-docs.pages.dev (or any other Pages origin).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Allow any Cloudflare Pages preview/prod origin. Tighten this list if
// you only ever deploy to one domain — e.g. set it to a single literal
// like 'https://waghete-docs.pages.dev'.
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

  // Preflight — handled here, no auth, no Supabase calls.
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
  let body: { email?: string; password?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, origin);
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const role = body.role;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400, origin);
  }
  if (!password || password.length < 8) {
    return json({ error: 'password_too_short' }, 400, origin);
  }
  if (role !== 'admin' && role !== 'viewer') {
    return json({ error: 'invalid_role' }, 400, origin);
  }

  // 3. Create the auth user.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip the verification email — internal tool
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'create_failed' }, 400, origin);
  }

  // 4. The on_auth_user_created trigger already inserted a 'viewer'
  //    profile. Upsert the real role over it.
  const { error: upsertErr } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, email, role });

  if (upsertErr) {
    // Best-effort cleanup: delete the auth user we just made so we don't
    // leave a user with no profile row.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: upsertErr.message }, 500, origin);
  }

  return json({ ok: true, user: { id: created.user.id, email, role } }, 200, origin);
});