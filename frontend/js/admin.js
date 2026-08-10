// Admin panel: upload, edit (modal), category management, user creation.
// Only initialized when the logged-in user is an admin.

import {
  uploadDocument,
  updateDocument,
  listCategories,
  createCategory,
  deleteCategory,
  listUsers,
  createUserViaEdgeFn,
  parseTags,
} from './api.js';
import { getSession } from './auth.js';
import { showToast } from './toast.js';
import { supabase, MAX_FILE_BYTES, ALLOWED_MIME } from './supabaseClient.js';

const els = {};

export async function initAdmin() {
  if (window.__sessionRole__ !== 'admin') return;

  Object.assign(els, {
    uploadForm:    document.getElementById('upload-form'),
    uploadFile:    document.getElementById('upload-file'),
    uploadTitle:   document.getElementById('upload-title'),
    uploadCatSel:  document.getElementById('upload-cat-selector'),
    uploadCatHidden: document.getElementById('upload-category'),
    uploadTags:    document.getElementById('upload-tags'),
    uploadError:   document.getElementById('upload-error'),

    // Edit modal
    editModal:     document.getElementById('edit-modal'),
    editForm:      document.getElementById('edit-form'),
    editId:        document.getElementById('edit-id'),
    editTitle:     document.getElementById('edit-title'),
    editCatSel:    document.getElementById('edit-cat-selector'),
    editCatHidden: document.getElementById('edit-category'),
    editTags:      document.getElementById('edit-tags'),
    editFile:      document.getElementById('edit-file'),
    editError:     document.getElementById('edit-error'),

    userForm:      document.getElementById('user-form'),
    userEmail:     document.getElementById('user-email-input'),
    userPassword:  document.getElementById('user-password'),
    userRole:      document.getElementById('user-role-select'),
    userError:     document.getElementById('user-error'),
    usersBody:     document.getElementById('users-body'),
  });

  // Edit modal close interactions.
  els.editModal.addEventListener('click', (ev) => {
    if (ev.target.dataset.close !== undefined) closeEditModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !els.editModal.hidden) closeEditModal();
  });

  // Build custom category selectors for both upload and edit forms.
  initCatSelector(els.uploadCatSel, els.uploadCatHidden);
  initCatSelector(els.editCatSel, els.editCatHidden);

  await renderUserList();

  els.uploadForm.addEventListener('submit', onUpload);
  els.editForm.addEventListener('submit', onEdit);
  els.userForm.addEventListener('submit', onCreateUser);

  window.addEventListener('docsearch:edit', (ev) => {
    openEditModal(ev.detail?.id);
  });
}

// ============================================================
// Custom category selector
// ============================================================

function initCatSelector(selector, hiddenInput) {
  const trigger = selector.querySelector('.cat-trigger');
  const dropdown = selector.querySelector('.cat-dropdown');
  const options  = selector.querySelector('.cat-options');
  const addBtn   = selector.querySelector('.cat-add-btn');
  const addInput = selector.querySelector('.cat-add-input');
  const label    = selector.querySelector('.cat-trigger-label');

  // Toggle dropdown.
  trigger.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const isOpen = !dropdown.hidden;
    closeAllDropdowns();
    if (!isOpen) {
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      await refreshCatOptions();
    }
  });

  // Select a category.
  options.addEventListener('click', (ev) => {
    const opt = ev.target.closest('[data-cat-id]');
    if (!opt) return;
    const id = opt.dataset.catId;
    const name = opt.dataset.catName;
    hiddenInput.value = id;
    label.textContent = name || '—';
    closeAllDropdowns();
  });

  // Delete a category.
  options.addEventListener('click', async (ev) => {
    const delBtn = ev.target.closest('[data-delete-cat]');
    if (!delBtn) return;
    ev.stopPropagation();
    const id = delBtn.dataset.deleteCat;
    const name = delBtn.closest('[data-cat-id]')?.dataset.catName || '';
    if (!confirm(`Delete category "${name}"? Documents using it will become uncategorized.`)) return;
    try {
      await deleteCategory(id);
      await refreshCatOptions();
      // Clear the hidden input if the deleted category was selected.
      if (hiddenInput.value === id) {
        hiddenInput.value = '';
        label.textContent = '—';
      }
      window.dispatchEvent(new CustomEvent('docsearch:refresh'));
    } catch (e) {
      showToast(`Delete failed: ${e.message}`, 'error');
    }
  });

  // Add new category.
  addBtn.addEventListener('click', () => {
    addBtn.hidden = true;
    addInput.hidden = false;
    addInput.value = '';
    addInput.focus();
  });

  addInput.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      await commitNewCategory();
    }
    if (ev.key === 'Escape') {
      cancelAddCategory();
    }
  });
  addInput.addEventListener('blur', (ev) => {
    // Block this blur from reaching the document listener (which would
    // close the dropdown before the click event can fire on the option).
    ev.stopImmediatePropagation();
    // Defer the close so clicks on options still fire first.
    setTimeout(() => {
      if (document.activeElement !== addInput) closeAllDropdowns();
    }, 160);
  });

  async function commitNewCategory() {
    const name = addInput.value.trim();
    if (!name) { cancelAddCategory(); return; }
    try {
      const cat = await createCategory(name);
      hiddenInput.value = cat.id;
      label.textContent = cat.name;
      await refreshCatOptions();
      closeAllDropdowns();
    } catch (e) {
      showToast(`Failed to create category: ${e.message}`, 'error');
    }
  }

  function cancelAddCategory() {
    addInput.hidden = true;
    addInput.value = '';
    addBtn.hidden = false;
  }

  async function refreshCatOptions() {
    const cats = await listCategories();
    const selectedId = hiddenInput.value;

    options.innerHTML = cats.length
      ? cats.map((c) => `
          <div class="cat-option" data-cat-id="${escAttr(c.id)}" data-cat-name="${escAttr(c.name)}" role="option" tabindex="-1">
            <span>${escHtml(c.name)}</span>
            <button type="button" class="cat-del-btn" data-delete-cat="${escAttr(c.id)}" title="Delete category" tabindex="-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `).join('')
      : '<div class="cat-option muted" style="padding:0.5rem 0.75rem;font-size:12px">No categories yet.</div>';
  }

  // Close dropdown when clicking outside.
  document.addEventListener('click', (ev) => {
    if (!selector.contains(ev.target)) closeAllDropdowns();
  });

  // Block all events inside the dropdown from reaching the document listener,
  // including blur which fires before click and would race to close the menu.
  dropdown.addEventListener('click',      (ev) => ev.stopPropagation());
  dropdown.addEventListener('mousedown', (ev) => ev.stopPropagation());
  dropdown.addEventListener('blur',      (ev) => ev.stopPropagation());

  function closeAllDropdowns() {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    cancelAddCategory();
  }
}

// ============================================================
// Edit modal open/close
// ============================================================

async function openEditModal(id) {
  if (!id) return;
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, category_id, tags')
      .eq('id', id)
      .single();
    if (error) throw error;

    els.editId.value       = data.id;
    els.editTitle.value    = data.title;
    els.editCatHidden.value = data.category_id ?? '';
    els.editTags.value     = (data.tags ?? []).join(', ');
    els.editFile.value     = '';
    showError(els.editError, '');

    // Sync trigger label.
    if (data.category_id) {
      const cats = await listCategories();
      const cat = cats.find((c) => c.id === data.category_id);
      els.editCatSel.querySelector('.cat-trigger-label').textContent = cat?.name ?? '—';
    } else {
      els.editCatSel.querySelector('.cat-trigger-label').textContent = '—';
    }

    els.editModal.hidden = false;
    els.editModal.setAttribute('aria-hidden', 'false');
    els.editTitle.focus();
  } catch (e) {
    showToast(`Could not load document: ${e.message}`, 'error');
  }
}

function closeEditModal() {
  els.editModal.hidden = true;
  els.editModal.setAttribute('aria-hidden', 'true');
  els.editForm.reset();
  showError(els.editError, '');
}

// ============================================================
// Upload
// ============================================================

async function onUpload(ev) {
  ev.preventDefault();
  showError(els.uploadError, '');

  const file = els.uploadFile.files[0];
  const title = els.uploadTitle.value.trim();
  const categoryId = els.uploadCatHidden.value;
  const tags = parseTags(els.uploadTags.value);

  if (!file) return showError(els.uploadError, 'Choose a file.');
  if (!title) return showError(els.uploadError, 'Title is required.');
  if (file.size > MAX_FILE_BYTES) {
    return showError(els.uploadError, `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB).`);
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return showError(els.uploadError, `File type not allowed: ${file.type}`);
  }

  const submit = els.uploadForm.querySelector('button[type=submit]');
  const origHtml = submit.innerHTML;
  setBtnLoading(submit, 'Uploading…');
  try {
    const session = await getSession();
    await uploadDocument({ file, title, categoryId: categoryId || null, tags, uploaderId: session.user.id });
    els.uploadForm.reset();
    els.uploadCatSel.querySelector('.cat-trigger-label').textContent = '—';
    window.dispatchEvent(new CustomEvent('docsearch:refresh'));
    showToast('Document uploaded.', 'success');
  } catch (e) {
    showError(els.uploadError, e.message);
  } finally {
    restoreBtn(submit, origHtml);
  }
}

// ============================================================
// Edit submit
// ============================================================

async function onEdit(ev) {
  ev.preventDefault();
  showError(els.editError, '');

  const id = els.editId.value;
  const title = els.editTitle.value.trim();
  const categoryId = els.editCatHidden.value;
  const tags = parseTags(els.editTags.value);
  const file = els.editFile.files[0] || null;

  if (!title) return showError(els.editError, 'Title is required.');
  if (file && file.size > MAX_FILE_BYTES) {
    return showError(els.editError, 'Replacement file too large.');
  }
  if (file && file.type && !ALLOWED_MIME.has(file.type)) {
    return showError(els.editError, `File type not allowed: ${file.type}`);
  }

  const submit = els.editForm.querySelector('button[type=submit]');
  const origHtml = submit.innerHTML;
  setBtnLoading(submit, 'Saving…');
  try {
    const session = await getSession();
    await updateDocument({
      id, title, categoryId: categoryId || null, tags, file,
      uploaderId: session.user.id,
    });
    closeEditModal();
    window.dispatchEvent(new CustomEvent('docsearch:refresh'));
    showToast('Document updated.', 'success');
  } catch (e) {
    showError(els.editError, e.message);
  } finally {
    restoreBtn(submit, origHtml);
  }
}

// ============================================================
// Users
// ============================================================

async function renderUserList() {
  try {
    const users = await listUsers();
    els.usersBody.innerHTML = users.map((u) => `
      <tr>
        <td class="title-cell">${escHtml(u.email)}</td>
        <td><span class="badge ${u.role}">${u.role}</span></td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : ''}</td>
      </tr>
    `).join('');
  } catch (e) {
    els.usersBody.innerHTML = `<tr><td colspan="3"><div class="empty-state error">${escHtml(e.message)}</div></td></tr>`;
  }
}

async function onCreateUser(ev) {
  ev.preventDefault();
  showError(els.userError, '');
  const email = els.userEmail.value.trim();
  const password = els.userPassword.value;
  const role = els.userRole.value;
  if (password.length < 8) {
    return showError(els.userError, 'Password must be at least 8 characters.');
  }
  const submit = els.userForm.querySelector('button[type=submit]');
  const origHtml = submit.innerHTML;
  setBtnLoading(submit, 'Creating…');
  try {
    await createUserViaEdgeFn({ email, password, role });
    els.userForm.reset();
    await renderUserList();
    showToast('User created.', 'success');
  } catch (e) {
    showError(els.userError, e.message);
  } finally {
    restoreBtn(submit, origHtml);
  }
}

// ============================================================
// helpers
// ============================================================

const SPINNER_SVG = `<svg class="btn-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>`;

function setBtnLoading(btn, label) {
  btn.disabled = true;
  btn.innerHTML = `${SPINNER_SVG}${label}`;
}

function restoreBtn(btn, originalHTML) {
  btn.disabled = false;
  btn.innerHTML = originalHTML;
}

function showError(el, msg) {
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}
