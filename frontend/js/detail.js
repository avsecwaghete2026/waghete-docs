// Document detail modal.
//
// Opens when a search row is clicked. Renders metadata in a sidebar on
// the left and a preview of the file on the right.
//
// Files live in Google Drive. The browser never talks to Drive directly
// — every file fetch goes through the drive-download Edge Function,
// which authenticates the caller's JWT and streams the bytes.
//
// Preview strategy:
//   - PDF → PDF.js (rendered page-by-page into <canvas> elements)
//   - image/* → <img> from the same blob URL
//   - anything else → "Download to view" card

import { downloadAsBlob } from './api.js';
import { isAdmin } from './auth.js';
import { deleteDocument } from './api.js';
import { supabase } from './supabaseClient.js';

const els = {};
let pdfjsLib = null;

export async function initDetail() {
  Object.assign(els, {
    modal:        document.getElementById('detail-modal'),
    title:        document.getElementById('detail-title'),
    category:     document.getElementById('detail-category'),
    tags:         document.getElementById('detail-tags'),
    uploaded:     document.getElementById('detail-uploaded'),
    uploader:     document.getElementById('detail-uploader'),
    type:         document.getElementById('detail-type'),
    size:         document.getElementById('detail-size'),
    download:     document.getElementById('detail-download'),
    edit:         document.getElementById('detail-edit'),
    deleteBtn:    document.getElementById('detail-delete'),
    previewHost:  document.getElementById('detail-preview-host'),
  });

  els.modal.addEventListener('click', (ev) => {
    if (ev.target.dataset.close !== undefined) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !els.modal.hidden) close();
  });

  window.addEventListener('docsearch:open', (ev) => {
    open(ev.detail?.id);
  });
}

// ============================================================
// Open / close
// ============================================================

export async function open(id) {
  if (!id) return;

  const { data: row, error } = await supabase
    .from('documents')
    .select('id, title, category_id, tags, drive_file_id, file_type, file_size, upload_date, ' +
            'categories(name), profiles!documents_uploaded_by_fkey(email)')
    .eq('id', id)
    .single();
  if (error) { alert(`Could not open document: ${error.message}`); return; }

  els.title.textContent    = row.title;
  els.category.innerHTML   = row.categories?.name
    ? `<span class="category-chip">${escapeHtml(row.categories.name)}</span>`
    : '<span class="muted">—</span>';
  els.tags.innerHTML       = (row.tags ?? []).length
    ? row.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')
    : '<span class="muted">—</span>';
  els.uploaded.textContent = row.upload_date
    ? new Date(row.upload_date).toLocaleString()
    : '—';
  els.uploader.textContent = row.profiles?.email ?? '—';
  els.type.textContent     = row.file_type ?? '—';
  els.size.textContent     = row.file_size ? formatBytes(row.file_size) : '—';

  els.edit.hidden       = !isAdmin();
  els.deleteBtn.hidden  = !isAdmin();

  els.download.onclick  = () => downloadRow(row);
  els.edit.onclick      = () => {
    close();
    window.dispatchEvent(new CustomEvent('docsearch:edit', { detail: { id: row.id } }));
  };
  els.deleteBtn.onclick = async () => {
    if (!confirm(`Delete "${row.title}"? This cannot be undone.`)) return;
    try {
      await deleteDocument(row.id);
      close();
      window.dispatchEvent(new CustomEvent('docsearch:refresh'));
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  els.modal.hidden = false;
  els.modal.setAttribute('aria-hidden', 'false');
  els.previewHost.innerHTML = `<div class="preview-loading">Loading preview…</div>`;
  await renderPreview(row);

  els.modal.querySelector('.modal-close').focus();
}

export function close() {
  els.modal.hidden = true;
  els.modal.setAttribute('aria-hidden', 'true');
  els.previewHost.innerHTML = '';
}

// ============================================================
// Preview
// ============================================================

async function renderPreview(row) {
  els.previewHost.innerHTML = '';

  try {
    const blob = await downloadAsBlob(row.drive_file_id);
    const url = URL.createObjectURL(blob);
    const mime = (row.file_type || '').toLowerCase();

    if (mime === 'application/pdf' || /\.pdf$/i.test(row.title)) {
      await renderPdf(url);
    } else if (mime.startsWith('image/')) {
      renderImage(url, row.title);
    } else {
      renderDownloadFallback(row, url);
    }

    // Revoke the blob URL after a delay so the iframe/img has time to
    // load it. (We can't revoke immediately for PDFs because PDF.js
    // fetches pages lazily.)
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) {
    els.previewHost.innerHTML =
      `<div class="preview-fallback"><div class="preview-fallback-icon">!</div>` +
      `<p>Preview unavailable.</p><p class="muted">${escapeHtml(e.message)}</p></div>`;
  }
}

function renderImage(url, title) {
  const img = document.createElement('img');
  img.className = 'preview-image';
  img.alt = title;
  img.src = url;
  els.previewHost.appendChild(img);
}

function renderDownloadFallback(row, blobUrl) {
  const div = document.createElement('div');
  div.className = 'preview-fallback';
  div.innerHTML = `
    <div class="preview-fallback-icon">⤓</div>
    <p><strong>${escapeHtml(row.title)}</strong></p>
    <p class="muted">${escapeHtml(row.file_type ?? 'Unknown type')} · ${escapeHtml(formatBytes(row.file_size))}</p>
    <p class="muted">This file type can't be previewed in the browser.</p>
    <a class="icon-btn primary" id="fallback-download" href="${blobUrl}" download="${escapeHtml(row.title)}">Download to view</a>
  `;
  els.previewHost.appendChild(div);
}

// ----- PDF.js rendering --------------------------------------------------

async function renderPdf(blobUrl) {
  const pdfjs = await loadPdfJs();

  const loadingTask = pdfjs.getDocument({ url: blobUrl, isEvalSupported: false });
  const pdf = await loadingTask.promise;

  const container = document.createElement('div');
  container.className = 'preview-pdf';
  els.previewHost.appendChild(container);

  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  toolbar.innerHTML = `
    <span class="muted">${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}</span>
    <a class="icon-btn primary" id="pdf-download" href="${blobUrl}" download="document.pdf">Download</a>
  `;
  container.appendChild(toolbar);

  const pagesHost = document.createElement('div');
  pagesHost.className = 'pdf-pages';
  container.appendChild(pagesHost);

  const viewportWidth = Math.min(els.previewHost.clientWidth - 48, 900);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const scale = viewportWidth / unscaledViewport.width;
    const viewport = page.getViewport({ scale });

    const pageWrap = document.createElement('div');
    pageWrap.className = 'pdf-page';

    const pageLabel = document.createElement('div');
    pageLabel.className = 'pdf-page-label muted';
    pageLabel.textContent = `Page ${i} of ${pdf.numPages}`;
    pageWrap.appendChild(pageLabel);

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    canvas.className = 'pdf-canvas';
    pageWrap.appendChild(canvas);

    pagesHost.appendChild(pageWrap);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

let pdfjsLoadPromise = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/+esm')
      .then((mod) => { pdfjsLib = mod; return mod; });
  }
  return pdfjsLoadPromise;
}

// ============================================================
// helpers
// ============================================================

async function downloadRow(row) {
  try {
    const blob = await downloadAsBlob(row.drive_file_id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = row.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    alert(`Download failed: ${e.message}`);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}