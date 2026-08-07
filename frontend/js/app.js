// App shell entry: route to login if unauthenticated, otherwise render
// the navbar (with role badge) and hand off to the search/admin modules.

import { getSession, signOut, ensureRole } from './auth.js';
import { initSearch } from './search.js';
import { initAdmin } from './admin.js';
import { initDetail } from './detail.js';

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

bootstrap();