// Shared auth + CORS helpers used by every Edge Function in this app.
//
// The caller sends their Supabase JWT in the Authorization header.
// We verify it via supabase.auth.getUser(jwt), then load the caller's
// profile to check the role. We DO NOT pass the caller's JWT to
// service_role-scoped queries — every function creates its own client
// with the appropriate key for what it's doing.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Accept any Cloudflare Pages domain (production + preview). Preview URLs
// are random hashes so we can't maintain an allowlist.
const KNOWN_ORIGINS = new Set([
  'https://waghete-docs.pages.dev',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);

function isAllowed(origin: string | null): string {
  if (!origin) return 'https://waghete-docs.pages.dev';
  if (KNOWN_ORIGINS.has(origin)) return origin;
  // Allow any Cloudflare Pages preview domain (*.pages.dev).
  if (origin.endsWith('.pages.dev')) return origin;
  // Fallback to the known production domain.
  return 'https://waghete-docs.pages.dev';
}

export function corsHeaders(origin: string | null): HeadersInit {
  const allowOrigin = isAllowed(origin);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(
  body: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export function preflight(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export interface Caller {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
}

export async function authenticate(
  req: Request,
  requireAdmin: boolean,
): Promise<{ caller: Caller } | { error: Response }> {
  const origin = req.headers.get('Origin');

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return { error: json({ error: 'unauthenticated' }, 401, origin) };

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: user, error: userErr } = await anon.auth.getUser(jwt);
  if (userErr || !user?.user) {
    return { error: json({ error: 'unauthenticated' }, 401, origin) };
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.user.id)
    .single();

  if (profileErr || !profile) {
    return { error: json({ error: 'profile_missing' }, 403, origin) };
  }

  if (requireAdmin && profile.role !== 'admin') {
    return { error: json({ error: 'forbidden' }, 403, origin) };
  }

  return {
    caller: {
      id: user.user.id,
      email: user.user.email ?? '',
      role: profile.role as 'admin' | 'viewer',
    },
  };
}