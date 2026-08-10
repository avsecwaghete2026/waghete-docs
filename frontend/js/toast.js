// Toast/snackbar notifications. Import and call showToast(msg, type)
// from any module. Type is 'success' | 'error' | 'info' (default info).

const ICONS = {
  success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

let container;

function getContainer() {
  if (!container) {
    container = document.getElementById('toast-container');
    if (container) container.hidden = false;
  }
  return container;
}

export function showToast(message, type = 'info') {
  const el = getContainer();
  if (!el) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `${ICONS[type] || ICONS.info}<span>${escapeHtml(message)}</span>`;
  el.appendChild(toast);

  // Auto-dismiss after 4 seconds.
  const timer = setTimeout(() => dismiss(timer, toast), 4000);

  // Allow manual dismiss by clicking.
  toast.addEventListener('click', () => dismiss(timer, toast));
}

function dismiss(timer, toast) {
  clearTimeout(timer);
  toast.classList.add('toast-out');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
