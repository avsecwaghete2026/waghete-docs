// Live search: debounced text input, immediate-on-change for filters,
// AbortController to drop stale responses, loading indicator that
// only appears if the request is slow.

import {
  searchDocuments,
  deleteDocument,
  listCategories,
  parseTags,
  formatDate,
  downloadAsBlob,
} from './api.js';
import { isAdmin, ensureRole } from './auth.js';

const TEXT_DEBOUNCE_MS = 250;
const SLOW_QUERY_MS = 200;

const els = {
  q: document.getElementById('search-q'),
  category: document.getElementById('search-category'),
  tag: document.getElementById('search-tag'),
  dateFrom: document.getElementById('search-date-from'),
  dateTo: document.getElementById('search-date-to'),
  body: document.getElementById('results-body'),
  count: document.getElementById('results-count'),
  loading: document.getElementById('results-loading'),
};

// In-flight AbortController — newer searches abort the older one.
let inflight = null;

export async function initSearch() {
  // Populate the category dropdown once.
  try {
    const cats = await listCategories();
    for (const c of cats) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      els.category.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load categories:', e);
  }

  // Text input → debounced. Filter inputs → immediate. Both paths funnel
  // through runSearch() which owns the AbortController.
  let textTimer = null;
  els.q.addEventListener('input', () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(runSearch, TEXT_DEBOUNCE_MS);
  });
  for (const el of [els.category, els.dateFrom, els.dateTo]) {
    el.addEventListener('change', runSearch);
  }
  els.tag.addEventListener('input', () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(runSearch, TEXT_DEBOUNCE_MS);
  });

  await runSearch();
}

async function runSearch() {
  // Cancel the previous request, if any. The new controller becomes
  // "the active one" — its abort handler is a no-op once it resolves.
  if (inflight) inflight.abort();
  const controller = new AbortController();
  inflight = controller;

  // Loading state only if the query is noticeably slow.
  let slowTimer = setTimeout(() => { els.loading.hidden = false; }, SLOW_QUERY_MS);

  try {
    const rows = await searchDocuments({
      q: els.q.value,
      categoryId: els.category.value,
      tags: parseTags(els.tag.value),
      dateFrom: els.dateFrom.value,
      dateTo: els.dateTo.value,
      signal: controller.signal,
    });
    // If another search started after we fired, abort() above will have
    // thrown AbortError before we got here — but guard anyway.
    if (controller.signal.aborted) return;
    renderResults(rows);
  } catch (e) {
    if (e?.code === 'aborted') return; // superseded — silent
    console.error(e);
    els.body.innerHTML = `<tr><td colspan="6"><div class="empty-state error">Search failed.</div></td></tr>`;
  } finally {
    clearTimeout(slowTimer);
    els.loading.hidden = true;
    if (inflight === controller) inflight = null;
  }
}

function renderResults(rows) {
  els.count.textContent = rows.length === 0
    ? 'No results.'
    : `${rows.length} result${rows.length === 1 ? '' : 's'}.`;

  if (rows.length === 0) {
    els.body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">⌕</div>No documents match your filters.</div></td></tr>`;
    return;
  }

  const admin = isAdmin();
  els.body.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}">
      <td class="title-cell"><a href="#" class="title-link" data-action="open">${escapeHtml(r.title)}</a></td>
      <td>${r.categories?.name ? `<span class="category-chip">${escapeHtml(r.categories.name)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${(r.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td>${formatDate(r.upload_date)}</td>
      <td>${escapeHtml(r.profiles?.email ?? '')}</td>
      <td class="actions">
        <button type="button" class="icon-btn primary" data-action="download">Download</button>
        ${admin ? `
          <button type="button" class="icon-btn" data-action="edit">Edit</button>
          <button type="button" class="icon-btn danger" data-action="delete">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');

  // Always re-attach after re-render so new rows are clickable.
  els.body.onclick = onRowClick;
}

async function onRowClick(ev) {
  const btn = ev.target.closest('button[data-action], a[data-action]');
  if (!btn) return;

  const tr = btn.closest('tr[data-id]');
  const id = tr?.dataset.id;
  if (!id) return;

  const action = btn.dataset.action;
  if (action === 'open')     return openDetail(id);
  if (action === 'download')  return downloadRow(id);
  if (action === 'edit')     return dispatchEdit(id);
  if (action === 'delete')   return deleteRow(id, tr, btn);
}

function openDetail(id) {
  window.dispatchEvent(new CustomEvent('docsearch:open', { detail: { id } }));
}

async function downloadRow(id) {
  try {
    const rowData = await lookupRow(id);
    if (!rowData) return;
    const blob = await downloadAsBlob(rowData.drive_file_id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rowData.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    alert(`Download failed: ${e.message}`);
  }
}

async function lookupRow(id) {
  const { supabase } = await import('./supabaseClient.js');
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, drive_file_id')
    .eq('id', id)
    .single();
  if (error) { alert(`Lookup failed: ${error.message}`); return null; }
  return data;
}

async function deleteRow(id, tr, btn) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  btn.disabled = true;
  try {
    await deleteDocument(id);
    tr.remove();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
    btn.disabled = false;
  }
}

function dispatchEdit(id) {
  // Hand off to the admin module via a custom event — keeps the modules
  // loosely coupled.
  window.dispatchEvent(new CustomEvent('docsearch:edit', { detail: { id } }));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}