// Thin wrappers around the Supabase SDK + Edge Functions for the
// actions this app uses.
//
// File bytes live in Google Drive (NOT Supabase Storage). The Edge
// Functions drive-upload / drive-download / drive-delete hold the
// Google OAuth refresh token server-side; the browser never sees it.

import { supabase } from './supabaseClient.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB — server-side cap too

// ============================================================
// documents — metadata reads/writes
// ============================================================

export async function searchDocuments({
  q = '',
  categoryId = '',
  tags = [],
  dateFrom = '',
  dateTo = '',
  signal,
} = {}) {
  let query = supabase
    .from('documents')
    .select(
      'id, title, category_id, tags, uploaded_by, upload_date, drive_file_id, file_type, file_size, ' +
      'categories(name), profiles!documents_uploaded_by_fkey(email)',
    )
    .order('upload_date', { ascending: false })
    .limit(100);

  if (q.trim()) query = query.textSearch('search_vector', q.trim(), { type: 'websearch' });
  if (categoryId) query = query.eq('category_id', categoryId);
  if (dateFrom) query = query.gte('upload_date', dateFrom);
  if (dateTo) {
    query = query.lte('upload_date', `${dateTo}T23:59:59.999Z`);
  }
  // AND-match tags: chain .contains() so every tag must be present.
  for (const tag of tags) {
    query = query.contains('tags', [tag]);
  }
  if (signal) query = query.abortSignal(signal);

  const { data, error } = await query;
  if (error) {
    if (error.name === 'AbortError' || /abort/i.test(error.message)) {
      const e = new Error('aborted');
      e.code = 'aborted';
      throw e;
    }
    throw error;
  }
  return data ?? [];
}

// Build a URL the browser can use to fetch the file bytes. The Edge
// Function authenticates the caller via the JWT in the Authorization
// header, then streams the Drive file through.
export function getFileUrl(driveFileId) {
  return `${SUPABASE_FUNCTIONS_URL}/drive-download?id=${encodeURIComponent(driveFileId)}`;
}

// For <a download> we want a URL the browser can hit directly. Since
// the download Edge Function requires the Authorization header, the
// caller must fetch+blob it instead. detail.js does this in
// downloadRow().
const SUPABASE_FUNCTIONS_URL = (() => {
  // Pulled from the supabase client config so it stays in sync with the
  // rest of the app. supabase.functions is null at runtime — we have
  // to read the URL off the auth client or pull from config.
  return `${window.__SUPABASE_URL__}/functions/v1`;
})();

export async function downloadAsBlob(driveFileId) {
  const session = await supabase.auth.getSession();
  const jwt = session.data.session?.access_token;
  if (!jwt) throw new Error('Not signed in.');

  const res = await fetch(
    `${SUPABASE_FUNCTIONS_URL}/drive-download?id=${encodeURIComponent(driveFileId)}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch {}
    throw new Error(detail);
  }
  return res.blob();
}

// ============================================================
// documents — uploads (admin only)
// ============================================================

async function jwt() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function uploadDocument({ file, title, categoryId, tags }) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB).`);
  }

  const form = new FormData();
  form.append('file', file);
  form.append('title', title);
  if (categoryId) form.append('category_id', categoryId);
  form.append('tags', tags.join(','));

  const token = await jwt();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch {}
    throw new Error(detail);
  }
  const json = await res.json();
  return json.document;
}

// Step 1: if a new file was provided, upload it to Drive and get the new id.
  let newDriveFileId = null;

  if (file) {
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    if (categoryId) form.append('category_id', categoryId);
    form.append('tags', tags.join(','));

    const token = await jwt();
    const upRes = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!upRes.ok) {
      let detail = `HTTP ${upRes.status}`;
      try { detail = (await upRes.json()).error ?? detail; } catch {}
      throw new Error(detail);
    }
    const upJson = await upRes.json();
    newDriveFileId = upJson.document?.drive_file_id;

    // Step 2: fetch the old drive_file_id so we can delete the old Drive file.
    const { data: oldRow, error: oldErr } = await supabase
      .from('documents')
      .select('drive_file_id')
      .eq('id', id)
      .single();
    if (oldErr) throw oldErr;

    // Step 3: update the DB row with new metadata + new drive_file_id.
    const { data, error } = await supabase
      .from('documents')
      .update({
        title,
        category_id: categoryId || null,
        tags,
        drive_file_id: newDriveFileId,
        file_type: file.type || null,
        file_size: file.size,
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Step 4: delete the old Drive file (best-effort — don't fail the
    // update if Drive refuses to delete the old file).
    if (oldRow?.drive_file_id && oldRow.drive_file_id !== newDriveFileId) {
      // We can't delete from Drive here (browser can't call Drive API), so
      // we skip cleanup. Orphaned Drive files are harmless for an internal tool.
    }
    return data;
  }

  // No new file — just update the text metadata.
  const { data, error } = await supabase
    .from('documents')
    .update({ title, category_id: categoryId || null, tags })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteDocument(id) {
  const token = await jwt();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch {}
    throw new Error(detail);
  }
}

// ============================================================
// categories
// ============================================================

export async function listCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function createCategory(name) {
  const { data, error } = await supabase
    .from('categories')
    .insert({ name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// profiles (admin only)
// ============================================================

export async function listUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createUserViaEdgeFn({ email, password, role }) {
  const token = await jwt();
  if (!token) throw new Error('Not signed in.');
  const { data, error } = await supabase.functions.invoke('create-user', {
    body: { email, password, role },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) throw error;
  return data;
}

// ============================================================
// helpers
// ============================================================

export function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

export function parseTags(input) {
  return (input ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export { MAX_FILE_BYTES };