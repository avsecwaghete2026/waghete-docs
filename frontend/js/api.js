// Thin wrappers around the Supabase SDK for the actions this app uses.
// Keeping them in one place means search.js and admin.js don't both
// have to remember the exact table/column names.

import { supabase, STORAGE_BUCKET, SIGNED_URL_TTL_SECONDS } from './supabaseClient.js';

// ============================================================
// documents
// ============================================================

export async function searchDocuments({
  q = '',
  categoryId = '',
  tags = [],
  dateFrom = '',
  dateTo = '',
  signal,
} = {}) {
  // Postgres FTS via websearch_to_tsquery (called through .textSearch())
  // plus filters. We don't use ilike on title — FTS is faster on a GIN
  // index and gives relevance ranking.
  let query = supabase
    .from('documents')
    .select(
      'id, title, category_id, tags, uploaded_by, upload_date, storage_path, file_type, file_size, ' +
      'categories(name), profiles!documents_uploaded_by_fkey(email)',
    )
    .order('upload_date', { ascending: false })
    .limit(100);

  if (q.trim()) query = query.textSearch('search_vector', q.trim(), { type: 'websearch' });
  if (categoryId) query = query.eq('category_id', categoryId);
  if (dateFrom) query = query.gte('upload_date', dateFrom);
  if (dateTo) {
    // Include the whole day on dateTo.
    query = query.lte('upload_date', `${dateTo}T23:59:59.999Z`);
  }
  // AND-match: every tag must be present. text[] && finds docs that
  // contain *any* of the tags, so for AND-match we check membership of
  // each tag individually and chain .contains().
  for (const tag of tags) {
    query = query.contains('tags', [tag]);
  }

  if (signal) query = query.abortSignal(signal);

  const { data, error } = await query;
  if (error) {
    // AbortError is the expected outcome when a newer query supersedes
    // this one — surface a sentinel the caller can ignore.
    if (error.name === 'AbortError' || /abort/i.test(error.message)) {
      const e = new Error('aborted');
      e.code = 'aborted';
      throw e;
    }
    throw error;
  }
  return data ?? [];
}

export async function getSignedUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

export async function uploadDocument({ file, title, categoryId, tags, uploaderId }) {
  // 1. Upload the bytes to Storage first. We need a storage_path before
  //    we can insert the documents row.
  const path = `documents/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;

  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadErr) throw uploadErr;

  // 2. Insert the metadata row. If this fails we try to clean up the
  //    orphan file, but we don't block the error on the cleanup.
  const { data, error } = await supabase
    .from('documents')
    .insert({
      title,
      category_id: categoryId || null,
      tags,
      uploaded_by: uploaderId,
      storage_path: path,
      file_type: file.type || null,
      file_size: file.size,
    })
    .select()
    .single();

  if (error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {});
    throw error;
  }
  return data;
}

export async function updateDocument({ id, title, categoryId, tags, file, uploaderId }) {
  let storage_path;
  let file_type;
  let file_size;

  if (file) {
    // Replace the storage object: upload new file, swap the row's path
    // to the new one, delete the old object. Two writes inside one
    // update — fine because the old file stays accessible until the
    // path swap completes.
    const { data: existing, error: fetchErr } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', id)
      .single();
    if (fetchErr) throw fetchErr;

    const newPath = `documents/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(newPath, file, { contentType: file.type, upsert: false });
    if (uploadErr) throw uploadErr;

    storage_path = newPath;
    file_type = file.type || null;
    file_size = file.size;

    // Don't await — best-effort cleanup; don't fail the request if it
    // errors (e.g. someone else already deleted it).
    supabase.storage.from(STORAGE_BUCKET).remove([existing.storage_path]).catch(() => {});
  }

  const patch = {
    title,
    category_id: categoryId || null,
    tags,
  };
  if (storage_path) {
    patch.storage_path = storage_path;
    patch.file_type = file_type;
    patch.file_size = file_size;
  }

  const { data, error } = await supabase
    .from('documents')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteDocument(id) {
  // Look up the storage path first so we can remove the file. We don't
  // fail the delete if the file removal errors.
  const { data: row, error: fetchErr } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', id)
    .single();
  if (fetchErr) throw fetchErr;

  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) throw error;

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storage_path]).catch(() => {});
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
  // We need the caller's JWT to pass to the Edge Function. The anon
  // client keeps the session in localStorage and exposes the current
  // access_token via getSession().
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData?.session?.access_token;
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

function sanitizeFilename(name) {
  // Strip path separators and characters that would break a storage key
  // or look weird in a URL. Keep the extension.
  return name.replace(/[^\w.\-]+/g, '_');
}

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