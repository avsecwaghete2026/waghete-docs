// Single Supabase client for the whole app. Created lazily so the
// config script (which sets window.__SUPABASE_URL__) has a chance to
// run before we try to read it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    'Supabase config missing — set window.__SUPABASE_URL__ and ' +
    'window.__SUPABASE_ANON_KEY__ before loading app.js.',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const STORAGE_BUCKET = 'documents';
export const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB

// Common office/doc formats only. Anything else is rejected client-side
// before we even hit the network. The storage bucket should also be
// capped server-side via the project's upload limits.
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);