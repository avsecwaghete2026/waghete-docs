// Runtime config.
//
// Values are baked in at deploy time — these are the *public* anon key
// and project URL, both of which are safe to ship in the browser. The
// service_role key is NEVER referenced here; it lives only in the
// create-user Edge Function's secrets.

export const SUPABASE_URL = window.__SUPABASE_URL__;
export const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__;

// Cloudflare Pages lets you inject env vars into static sites via a
// _headers file's placeholder or, more commonly, a small inline script.
// This file expects the host page to expose the two values above before
// this module loads (see the snippet at the bottom of this comment).
//
// Add this near the top of <head> in every HTML page, with the real
// values set in Cloudflare Pages → Settings → Environment variables
// and substituted via a tiny build step or the Pages Functions preview:
//
//   <script>
//     window.__SUPABASE_URL__ = 'https://YOUR-PROJECT.supabase.co';
//     window.__SUPABASE_ANON_KEY__ = 'YOUR-ANON-KEY';
//   </script>