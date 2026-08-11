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
  sort = 'updated_desc',
  signal,
} = {}) {
  const qTrim = q.trim();

  // When there's a text query, fetch more rows and filter client-side
  // across title + category + tags + uploader (PostgREST .or() can't
  // reach joined/nested columns). Keep server-side filters for perf.
  const fetchMore = !!qTrim;

  // Map our sort key → (column, ascending). Falls back to updated_desc
  // so an unknown key never errors out — the search still runs.
  const SORT_MAP = {
    name_asc:      ['title',        true],
    name_desc:     ['title',        false],
    updated_desc:  ['updated_at',   false],
    updated_asc:   ['updated_at',   true],
    uploaded_desc: ['upload_date',  false],
    uploaded_asc:  ['upload_date',  true],
    type_asc:      ['file_type',    true],
    size_desc:     ['file_size',    false],
    size_asc:      ['file_size',    true],
  };
  const [sortCol, sortAsc] = SORT_MAP[sort] ?? SORT_MAP.updated_desc;

  let query = supabase
    .from('documents')
    .select(
      'id, title, category_id, tags, uploaded_by, upload_date, updated_at, drive_file_id, file_type, file_size, deleted_at, ' +
      'categories(name), profiles!documents_uploaded_by_fkey(email)',
    )
    .is('deleted_at', null)
    .order(sortCol, { ascending: sortAsc })
    .limit(fetchMore ? 300 : 100);

  if (categoryId) query = query.eq('category_id', categoryId);
  if (dateFrom) query = query.gte('upload_date', dateFrom);
  if (dateTo) query = query.lte('upload_date', `${dateTo}T23:59:59.999Z`);
  for (const tag of tags) {
    query = query.contains('tags', [tag]);
  }
  if (signal && !fetchMore) query = query.abortSignal(signal);

  let data;
  try {
    ({ data } = await query);
  } catch (error) {
    if (error.name === 'AbortError' || /abort/i.test(error.message)) {
      const e = new Error('aborted');
      e.code = 'aborted';
      throw e;
    }
    throw error;
  }
  if (signal?.aborted) {
    const e = new Error('aborted');
    e.code = 'aborted';
    throw e;
  }

  if (fetchMore) {
    const q_ = qTrim.toLowerCase();
    return (data ?? []).filter((r) =>
      r.title?.toLowerCase().includes(q_) ||
      r.categories?.name?.toLowerCase().includes(q_) ||
      (r.tags ?? []).some((t) => t.toLowerCase().includes(q_)) ||
      r.profiles?.email?.toLowerCase().includes(q_)
    ).slice(0, 100);
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
  if (file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('Replacement file too large.');
    }

    // Look up the old Drive file ID so we can delete it after the upload.
    const { data: existing } = await supabase
      .from('documents')
      .select('drive_file_id')
      .eq('id', id)
      .single();
    const oldDriveFileId = existing?.drive_file_id ?? null;

    // Upload the new file. The server treats `document_id` as a signal
    // to UPDATE the row in place rather than INSERT a new one.
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    if (categoryId) form.append('category_id', categoryId);
    form.append('tags', (tags ?? []).join(','));
    form.append('document_id', id);

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
    const data = upJson.document;

    // Delete the old Drive file now that the new one is safely stored.
    if (oldDriveFileId && oldDriveFileId !== data?.drive_file_id) {
      try {
        await fetch(`${SUPABASE_FUNCTIONS_URL}/drive-delete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: oldDriveFileId }),
        });
      } catch (_) { /* best-effort — the row is already updated */ }
    }

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

export async function deleteCategory(id) {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id);
  if (error) throw error;
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

export async function deleteUserViaEdgeFn({ userId }) {
  const jwt = await getJwt();
  if (!jwt) throw new Error('Not signed in.');
  const { data, error } = await supabase.functions.invoke('delete-user', {
    body: { user_id: userId },
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (error) throw error;
  return data;
}

export async function resetUserPasswordViaEdgeFn({ userId, newPassword }) {
  const jwt = await getJwt();
  if (!jwt) throw new Error('Not signed in.');
  const { data, error } = await supabase.functions.invoke('reset-user-password', {
    body: { user_id: userId, new_password: newPassword },
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
