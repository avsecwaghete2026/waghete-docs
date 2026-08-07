// App shell entry: route to login if unauthenticated, otherwise render
// the navbar (with role badge) and hand off to the search/admin modules.

import { getSession, signOut, ensureRole, isAdmin } from './auth.js';
import { initSearch } from './search.js';
import { initAdmin } from './admin.js';

const els = {
  email: document.getElementById('user-email'),
  role:  document.getElementById('user-role'),
  logout: document.getElementById('logout-btn'),
  tabs:   document.getElementById('tabs'),
  adminTab: document.getElementById('admin-tab'),
  searchView: document.getElementById('view-search'),
  adminView:  document.getElementById('view-admin'),
};

async function bootstrap() {
  // Not signed in? Send to login.
  const session = await getSession();
  if (!session) {
    window.location.href = './login.html';
    return;
  }

  // Pull the role so the navbar + admin tab can render correctly.
  try {
    const profile = await ensureRole();
    if (!profile) { window.location.href = './login.html'; return; }
  } catch (e) {
    console.error('Profile load failed:', e);
    alert('Could not load profile.');
    await signOut();
    window.location.href = './login.html';
    return;
  }

  // Render navbar.
  els.email.textContent = window.__sessionEmail__;
  els.role.textContent = window.__sessionRole__;
  els.role.classList.add(window.__sessionRole__);

  // Wire up tabs.
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.view));
  }

  els.logout.addEventListener('click', async () => {
    await signOut();
    window.location.href = './login.html';
  });

  // Show admin tab only for admins.
  if (isAdmin()) {
    els.adminTab.hidden = false;
    await initAdmin();
  }

  await initSearch();

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

bootstrap();