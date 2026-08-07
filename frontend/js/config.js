// Runtime config. The build step (build-config.js) generates
// js/config.runtime.js, which sets window.__SUPABASE_URL__ and
// window.__SUPABASE_ANON_KEY__ before any module scripts load —
// because the HTML loads it as a plain (synchronous) script in <head>
// before any type="module" tag. See index.html / login.html.

export const SUPABASE_URL = window.__SUPABASE_URL__;
export const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__;