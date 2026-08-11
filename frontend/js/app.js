// App shell entry: route to login if unauthenticated, otherwise render
// the sidebar (with role badge) and hand off to the search/admin modules.

import { getSession, signOut, ensureRole } from './auth.js';
import { initSearch } from './search.js';
import { initAdmin } from './admin.js';
import { initDetail } from './detail.js';

const els = {
  email:    document.getElementById('user-email'),
  avatar:   document.getElementById('user-avatar'),
  role:     document.getElementById('user-role'),
  logout:   document.getElementById('logout-btn'),
  tabs:     document.getElementById('tabs'),
  adminTab: document.getElementById('admin-tab'),
  sidebar:  document.getElementById('sidebar'),
  toggle:   document.getElementById('sidebar-toggle'),
  searchView: document.getElementById('view-search'),
  adminView:  document.getElementById('view-admin'),
};

async function bootstrap() {
  // Not signed in (or session was unusable)? Send to login.
  const session = await getSession();
  if (!session) {
    window.location.replace('./login.html');
    return;
  }

  // Pull the role. ensureRole() clears the session and returns null if
  // the profile row is missing — which means the JWT refers to a user
  // whose profile we couldn't read.
  const profile = await ensureRole();
  if (!profile) {
    window.location.replace('./login.html');
    return;
  }

  // Auth confirmed — unhide the shell that the pre-auth block kept
  // hidden to avoid a flash of the main screen on cold load.
  document.documentElement.classList.remove('preauth');

  // Render sidebar user block (or login button if unauthenticated).
  renderSidebarUser(profile);

  // Wire up tabs.
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.view));
  }

  // Wire up sidebar collapse. Persist the choice in localStorage so it
  // sticks across reloads.
  applySidebarState();
  els.toggle.addEventListener('click', () => {
    const collapsed = !els.sidebar.classList.contains('collapsed');
    els.sidebar.classList.toggle('collapsed', collapsed);
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('waghete:sidebar', collapsed ? '1' : '0'); } catch (_) {}
  });

  els.logout.addEventListener('click', async () => {
    await signOut();
    window.location.replace('./login.html');
  });

  // Show login button for unauthenticated visitors (if they somehow reach index.html).
  // No login button in sidebar — they go directly to the login page.

  // Show admin tab only for admins. Use style.display so this bypasses
  // the CSS cascade entirely.
  els.adminTab.style.display = profile.role === 'admin' ? '' : 'none';
  if (profile.role === 'admin') {
    await initAdmin();
  }

  await initSearch();
  await initDetail();

  // Refresh search whenever the admin does an action that mutates docs.
  window.addEventListener('docsearch:refresh', () => {
    document.getElementById('search-q').dispatchEvent(new Event('input'));
  });
}

function applySidebarState() {
  let collapsed = false;
  try { collapsed = localStorage.getItem('waghete:sidebar') === '1'; } catch (_) {}
  els.sidebar.classList.toggle('collapsed', collapsed);
  els.toggle.setAttribute('aria-expanded', String(!collapsed));
}

function switchTab(view) {
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === view);
  }
  els.searchView.classList.toggle('active', view === 'search');
  els.adminView.classList.toggle('active', view === 'admin');
}

function renderAvatar(img, email) {
  // Generate a consistent color avatar from the email hash.
  const hue = [...email].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0xffff, 0);
  const bg = `hsl(${hue % 360}, 45%, 55%)`;
  const initials = email.split('@')[0].slice(0, 2).toUpperCase();
  const size = 64;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="${bg}" rx="32"/>` +
    `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" ` +
    `fill="#fff" font-family="system-ui,sans-serif" font-size="22" font-weight="700">${initials}</text>` +
    `</svg>`;
  img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  img.alt = initials;
  img.hidden = false;
}

function renderSidebarUser(profile) {
  const role = profile.role === 'admin' ? 'admin' : 'viewer';
  els.email.textContent = profile.email;
  els.role.textContent = role;
  els.role.className = 'badge ' + role;
  renderAvatar(els.avatar, profile.email);
}

bootstrap();