// Login page entry. Uses Supabase Auth — no custom hashing or cookies
// here, those live in the supabase-js client.

import { getSession, signIn } from './auth.js';

const form = document.getElementById('login-form');
const errEl = document.getElementById('login-error');
const submit = document.getElementById('login-submit');

function showError(msg) {
  if (!msg) { errEl.hidden = true; errEl.textContent = ''; return; }
  errEl.hidden = false;
  errEl.textContent = msg;
}

// If the user already has a valid session, don't make them sign in again.
getSession().then((session) => {
  if (session) window.location.replace('./index.html');
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('');
  submit.disabled = true;
  try {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    await signIn(email, password);
    // Bounce to the app shell. Hash routing would also be fine, but a
    // full nav avoids any cached login state from the previous user.
    window.location.href = './index.html';
  } catch (e) {
    showError(e.message || 'Sign in failed.');
    submit.disabled = false;
  }
});