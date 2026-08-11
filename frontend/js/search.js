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
import { showToast } from './toast.js';

const TEXT_DEBOUNCE_MS = 250;
const SLOW_QUERY_MS = 200;

const els = {
  q: document.getElementById('search-q'),
  category: document.getElementById('search-category'),
  tag: document.getElementById('search-tag'),
  dateFrom: document.getElementById('search-date-from'),
  dateTo: document.getElementById('search-date-to'),
  sort: document.getElementById('search-sort'),
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
  for (const el of [els.category, els.dateFrom, els.dateTo, els.sort]) {
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
      sort: els.sort.value,
      signal: controller.signal,
    });
    // If another search started after we fired, abort() above will have
    // thrown AbortError before we got here — but guard anyway.
    if (controller.signal.aborted) return;
    renderResults(rows);
  } catch (e) {
    if (e?.code === 'aborted') return; // superseded — silent
    console.error(e);
    els.body.innerHTML = `<tr><td colspan="7"><div class="empty-state error">Search failed.</div></td></tr>`;
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
    els.body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">⌕</div>No documents match your filters.</div></td></tr>`;
    return;
  }

  const admin = isAdmin();
  els.body.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}" class="doc-row">
      <td class="title-cell" data-label="Title"><span class="title-link">${escapeHtml(r.title)}</span></td>
      <td data-label="Category">${r.categories?.name ? `<span class="category-chip">${escapeHtml(r.categories.name)}</span>` : '<span class="muted">—</span>'}</td>
      <td data-label="Tags">${(r.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td data-label="Uploaded">${formatDate(r.upload_date)}</td>
      <td data-label="Modified">${formatDate(r.updated_at)}</td>
      <td data-label="By">${escapeHtml(r.profiles?.email ?? '')}</td>
      <td class="actions" data-label="Actions">
        <button type="button" class="icon-btn primary" data-action="download">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        ${admin ? `
          <button type="button" class="icon-btn" data-action="edit">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Edit
          </button>
          <button type="button" class="icon-btn danger" data-action="delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Delete
          </button>
        ` : ''}
      </td>
    </tr>
  `).join('');

  // Single delegated handler: row clicks → detail, button clicks → actions.
  els.body.onclick = onRowClick;
}

function onRowClick(ev) {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;

  const id = tr.dataset.id;
  const btn = ev.target.closest('button[data-action]');

  // Clicking any action button → do that action.
  if (btn) {
    switch (btn.dataset.action) {
      case 'download': downloadRow(id); break;
      case 'edit':    dispatchEdit(id); break;
      case 'delete':  deleteRow(id, tr, btn); break;
    }
    return;
  }

  // Clicking anywhere else on the row → open detail modal.
  openDetail(id);
}

function openDetail(id) {
  window.dispatchEvent(new CustomEvent('docsearch:open', { detail: { id } }));
}

async function downloadRow(id) {
  try {
    const btn = document.activeElement;
    const origHtml = btn?.tagName === 'BUTTON' ? btn.innerHTML : '';
    if (btn?.tagName === 'BUTTON') {
      btn.disabled = true;
      btn.innerHTML = `<svg class="btn-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>…`;
    }
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
    showToast('Download started.', 'info');
  } catch (e) {
    showToast(`Download failed: ${e.message}`, 'error');
  } finally {
    const btns = document.querySelectorAll('[data-action="download"]');
    btns.forEach(b => { b.disabled = false; b.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download`; });
  }
}

async function lookupRow(id) {
  const { supabase } = await import('./supabaseClient.js');
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, drive_file_id')
    .eq('id', id)
    .is('deleted_at', null)
    .single();
  if (error) { showToast(`Lookup failed: ${error.message}`, 'error'); return null; }
  return data;
}

async function deleteRow(id, tr, btn) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  btn.disabled = true;
  try {
    await deleteDocument(id);
    tr.remove();
    showToast('Document deleted.', 'success');
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, 'error');
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