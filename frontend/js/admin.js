// Admin panel: upload, edit (modal), category management, user creation.
// Only initialized when the logged-in user is an admin.

import {
  uploadDocument,
  updateDocument,
  listCategories,
  createCategory,
  listUsers,
  createUserViaEdgeFn,
  parseTags,
} from './api.js';
import { getSession } from './auth.js';
import { supabase, MAX_FILE_BYTES, ALLOWED_MIME } from './supabaseClient.js';

const els = {};

export async function initAdmin() {
  // isAdmin() is checked by app.js before calling us; double-check here
  // so this module is safe to import unconditionally.
  if (window.__sessionRole__ !== 'admin') return;

  Object.assign(els, {
    uploadForm:    document.getElementById('upload-form'),
    uploadFile:    document.getElementById('upload-file'),
    uploadTitle:   document.getElementById('upload-title'),
    uploadCategory:document.getElementById('upload-category'),
    uploadTags:    document.getElementById('upload-tags'),
    uploadError:   document.getElementById('upload-error'),

    // Edit modal
    editModal:     document.getElementById('edit-modal'),
    editForm:      document.getElementById('edit-form'),
    editId:        document.getElementById('edit-id'),
    editTitle:     document.getElementById('edit-title'),
    editCategory:  document.getElementById('edit-category'),
    editTags:      document.getElementById('edit-tags'),
    editFile:      document.getElementById('edit-file'),
    editError:     document.getElementById('edit-error'),

    categoryForm:  document.getElementById('category-form'),
    categoryName:  document.getElementById('category-name'),
    categoryList:  document.getElementById('category-list'),
    categoryError: document.getElementById('category-error'),

    userForm:      document.getElementById('user-form'),
    userEmail:     document.getElementById('user-email-input'),
    userPassword:  document.getElementById('user-password'),
    userRole:      document.getElementById('user-role-select'),
    userError:     document.getElementById('user-error'),
    usersBody:     document.getElementById('users-body'),
  });

  // Close interactions for the edit modal: backdrop, X, Cancel button,
  // Escape key (the detail modal also listens for Escape; we coordinate
  // by closing only the topmost open modal).
  els.editModal.addEventListener('click', (ev) => {
    if (ev.target.dataset.close !== undefined) closeEditModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!els.editModal.hidden) closeEditModal();
  });

  await populateCategoryDropdowns();
  await renderCategoryList();
  await renderUserList();

  els.uploadForm.addEventListener('submit', onUpload);
  els.editForm.addEventListener('submit', onEdit);
  els.categoryForm.addEventListener('submit', onAddCategory);
  els.userForm.addEventListener('submit', onCreateUser);

  // Listen for "open edit" events from the detail modal.
  window.addEventListener('docsearch:edit', (ev) => {
    openEditModal(ev.detail?.id);
  });
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

    // Make sure the dropdown reflects current categories (an admin may
    // have added categories since the page loaded).
    await populateCategoryDropdowns();

    els.editId.value       = data.id;
    els.editTitle.value    = data.title;
    els.editCategory.value = data.category_id ?? '';
    els.editTags.value     = (data.tags ?? []).join(', ');
    els.editFile.value     = '';
    showError(els.editError, '');

    els.editModal.hidden = false;
    els.editModal.setAttribute('aria-hidden', 'false');
    els.editTitle.focus();
  } catch (e) {
    alert(`Could not load document: ${e.message}`);
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
  const categoryId = els.uploadCategory.value;
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
  const origText = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Uploading…';
  try {
    const session = await getSession();
    const uploaderId = session.user.id;
    await uploadDocument({ file, title, categoryId, tags, uploaderId });
    els.uploadForm.reset();
    window.dispatchEvent(new CustomEvent('docsearch:refresh'));
  } catch (e) {
    showError(els.uploadError, e.message);
  } finally {
    submit.disabled = false;
    submit.textContent = origText;
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
  const categoryId = els.editCategory.value;
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
  const origText = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Saving…';
  try {
    const session = await getSession();
    await updateDocument({
      id, title, categoryId, tags, file,
      uploaderId: session.user.id,
    });
    closeEditModal();
    window.dispatchEvent(new CustomEvent('docsearch:refresh'));
  } catch (e) {
    showError(els.editError, e.message);
  } finally {
    submit.disabled = false;
    submit.textContent = origText;
  }
}

// ============================================================
// Categories
// ============================================================

async function populateCategoryDropdowns() {
  const cats = await listCategories();
  for (const sel of [els.uploadCategory, els.editCategory]) {
    // Keep the first "—" option, drop any others.
    while (sel.options.length > 1) sel.remove(1);
    for (const c of cats) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
  }
}

async function renderCategoryList() {
  const cats = await listCategories();
  els.categoryList.innerHTML = cats.length
    ? cats.map((c) => `<li>${escapeHtml(c.name)}</li>`).join('')
    : '<li class="muted">No categories yet.</li>';
}

async function onAddCategory(ev) {
  ev.preventDefault();
  showError(els.categoryError, '');
  const name = els.categoryName.value.trim();
  if (!name) return;
  try {
    await createCategory(name);
    els.categoryForm.reset();
    await populateCategoryDropdowns();
    await renderCategoryList();
    window.dispatchEvent(new CustomEvent('docsearch:refresh'));
  } catch (e) {
    showError(els.categoryError, e.message);
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
        <td class="title-cell">${escapeHtml(u.email)}</td>
        <td><span class="badge ${u.role}">${u.role}</span></td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : ''}</td>
      </tr>
    `).join('');
  } catch (e) {
    els.usersBody.innerHTML = `<tr><td colspan="3"><div class="empty-state error">${escapeHtml(e.message)}</div></td></tr>`;
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
  submit.disabled = true;
  try {
    await createUserViaEdgeFn({ email, password, role });
    els.userForm.reset();
    await renderUserList();
  } catch (e) {
    showError(els.userError, e.message);
  } finally {
    submit.disabled = false;
  }
}

// ============================================================
// helpers
// ============================================================

function showError(el, msg) {
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}