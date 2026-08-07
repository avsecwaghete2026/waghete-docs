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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // 1. Authenticate the caller.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'unauthenticated' }, 401);

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: caller, error: callerErr } = await anon.auth.getUser(jwt);
  if (callerErr || !caller?.user) return json({ error: 'unauthenticated' }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', caller.user.id)
    .single();

  if (profileErr || profile?.role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  // 2. Parse + validate the request body.
  let body: { email?: string; password?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const role = body.role;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }
  if (!password || password.length < 8) {
    return json({ error: 'password_too_short' }, 400);
  }
  if (role !== 'admin' && role !== 'viewer') {
    return json({ error: 'invalid_role' }, 400);
  }

  // 3. Create the auth user.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip the verification email — internal tool
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'create_failed' }, 400);
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
    return json({ error: upsertErr.message }, 500);
  }

  return json({ ok: true, user: { id: created.user.id, email, role } });
});