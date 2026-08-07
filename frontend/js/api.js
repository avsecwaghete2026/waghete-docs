// Thin wrappers around the Supabase SDK + Edge Functions.
//
// File bytes live in Google Drive (NOT Supabase Storage). The Edge
// Functions drive-upload / drive-download / drive-delete hold the
// Google OAuth refresh token server-side; the browser never sees it.

import { supabase } from './supabaseClient.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB

const SUPABASE_FUNCTIONS_URL = `${window.__SUPABASE_URL__}/functions/v1`;

async function getJwt() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

// ============================================================
// documents — search
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

  if (q.trim()) {
    const q_ = q.trim();
    // Case-insensitive OR across title, category, tags, and uploader email.
    query = query.or(
      `title.ilike.%${q_}%,categories.name.ilike.%${q_}%,tags.ilike.%${q_}%,profiles.email.ilike.%${q_}%`,
    );
  }
  if (categoryId) query = query.eq('category_id', categoryId);
  if (dateFrom) query = query.gte('upload_date', dateFrom);
  if (dateTo) query = query.lte('upload_date', `${dateTo}T23:59:59.999Z`);
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

// ============================================================
// documents — download (returns a blob)
// ============================================================

export async function downloadAsBlob(driveFileId) {
  const jwt = await getJwt();
  if (!jwt) throw new Error('Not signed in.');

  const res = await fetch(
    `${SUPABASE_FUNCTIONS_URL}/drive-download?id=${encodeURIComponent(driveFileId)}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch { /* ok */ }
    throw new Error(detail);
  }
  return res.blob();
}

// ============================================================
// documents — upload (admin only)
// ============================================================

export async function uploadDocument({ file, title, categoryId, tags }) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB).`);
  }

  const form = new FormData();
  form.append('file', file);
  form.append('title', title);
  if (categoryId) form.append('category_id', categoryId);
  form.append('tags', (tags ?? []).join(','));

  const jwt = await getJwt();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch { /* ok */ }
    throw new Error(detail);
  }
  const json = await res.json();
  return json.document;
}

// ============================================================
// documents — update (admin only)
// ============================================================

export async function updateDocument({ id, title, categoryId, tags, file }) {
  let newDriveFileId = null;

  if (file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('Replacement file too large.');
    }
    // Upload the new file.
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    if (categoryId) form.append('category_id', categoryId);
    form.append('tags', (tags ?? []).join(','));

    const jwt = await getJwt();
    const upRes = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!upRes.ok) {
      let detail = `HTTP ${upRes.status}`;
      try { detail = (await upRes.json()).error ?? detail; } catch { /* ok */ }
      throw new Error(detail);
    }
    const upJson = await upRes.json();
    newDriveFileId = upJson.document?.drive_file_id;

    // Update the DB row with new metadata.
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
    return data;
  }

  // No new file — update metadata only.
  const { data, error } = await supabase
    .from('documents')
    .update({ title, category_id: categoryId || null, tags })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// documents — delete (admin only)
// ============================================================

export async function deleteDocument(id) {
  const jwt = await getJwt();
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch { /* ok */ }
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
  const jwt = await getJwt();
  if (!jwt) throw new Error('Not signed in.');
  const { data, error } = await supabase.functions.invoke('create-user', {
    body: { email, password, role },
    headers: { Authorization: `Bearer ${jwt}` },
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
