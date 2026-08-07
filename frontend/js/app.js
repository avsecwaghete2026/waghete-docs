// App shell entry: route to login if unauthenticated, otherwise render
// the navbar (with role badge) and hand off to the search/admin modules.

import { getSession, signOut, ensureRole } from './auth.js';
import { initSearch } from './search.js';
import { initAdmin } from './admin.js';
import { initDetail } from './detail.js';

const els = {
  email:   document.getElementById('user-email'),
  avatar:  document.getElementById('user-avatar'),
  role:    document.getElementById('user-role'),
  logout:  document.getElementById('logout-btn'),
  tabs:    document.getElementById('tabs'),
  adminTab: document.getElementById('admin-tab'),
  searchView: document.getElementById('view-search'),
  adminView:  document.getElementById('view-admin'),
};

async function bootstrap() {
  // Not signed in (or session was unusable)? Send to login.
  const session = await getSession();
  if (!session) {
    window.location.href = './login.html';
    return;
  }

  // Pull the role. ensureRole() clears the session and returns null if
  // the profile row is missing — which means the JWT refers to a user
  // whose profile we couldn't read.
  const profile = await ensureRole();
  if (!profile) {
    window.location.href = './login.html';
    return;
  }

  // Render navbar.
  els.email.textContent = profile.email;
  els.role.textContent = profile.role;
  els.role.classList.add(profile.role);
  renderAvatar(els.avatar, profile.email);

  // Wire up tabs.
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.view));
  }

  els.logout.addEventListener('click', async () => {
    await signOut();
    window.location.href = './login.html';
  });

  // Show admin tab only for admins.
  if (profile.role === 'admin') {
    els.adminTab.hidden = false;
    await initAdmin();
  }

  await initSearch();
  await initDetail();

  // Refresh search whenever the admin does an action that mutates docs.
  window.addEventListener('docsearch:refresh', () => {
    document.getElementById('search-q').dispatchEvent(new Event('input'));
  });
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

bootstrap();