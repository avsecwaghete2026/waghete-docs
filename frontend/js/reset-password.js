// Reset password page — two paths into the new-password step:
//   A. Magic link: user clicks the link in the recovery email. The
//      link lands here with #access_token=...&refresh_token=... in the
//      URL hash. We parse the hash, set the session, and jump straight
//      to the new-password form.
//   B. Email-only: user lands here directly (no hash). We show the
//      email form, send the magic link, and tell them to check their
//      inbox. (No code-entry step — the link IS the verification.)

import { getSession } from './auth.js';
import { requestRecoveryCode, updateOwnPassword } from './api.js';
import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';

const stepEl = (id) => document.getElementById(id);
const requestForm = stepEl('reset-request-form');
const newpassForm  = stepEl('reset-newpass-form');
const subtitle     = stepEl('step-subtitle');

// Already signed in? Skip to the new-password form.
(async function redirectIfSignedIn() {
  const s = await getSession();
  if (s) {
    pendingEmail = s.user?.email || '';
    showStep('newpass');
  }
})();

// Capture the email so the request form can re-fill it if the user
// comes back to it.
let pendingEmail = '';

function showStep(name) {
  for (const f of [requestForm, newpassForm]) {
    f.classList.toggle('hidden', f !== stepEl(name));
  }
  if (name === 'request') {
    subtitle.textContent = 'Enter the email on your account.';
    requestForm.querySelector('input').focus();
  } else if (name === 'newpass') {
    subtitle.textContent = 'Choose a new password.';
    newpassForm.querySelector('input').focus();
  }
}

function showError(form, msg) {
  const el = form.querySelector('.error');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function setBusy(form, busy) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = busy;
}

// ============================================================
// Magic-link landing: parse the hash tokens, set the session,
// then jump straight to the new-password form.
// ============================================================
async function handleHashSession() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return false;

  // Common shapes:
  //   access_token=...&refresh_token=...&expires_at=...   (PKCE flow)
  //   error=access_denied&error_code=otp_expired&...     (error path)
  const params = new URLSearchParams(hash);
  const accessToken  = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const errCode      = params.get('error_code') || params.get('error');

  if (errCode) {
    // Surface the failure on the request form so the user can retry.
    showError(requestForm, `Recovery link ${errCode === 'otp_expired' ? 'expired' : 'failed'}. Please request a new one.`);
    showStep('request');
    // Clean the URL so a refresh doesn't replay the error.
    history.replaceState(null, '', window.location.pathname);
    return true;
  }

  if (!accessToken || !refreshToken) return false;

  // Hand the tokens to the Supabase client so getSession() sees them.
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    showError(requestForm, `Recovery link failed: ${error.message}`);
    showStep('request');
    history.replaceState(null, '', window.location.pathname);
    return true;
  }

  // Strip the hash so it's not visible in the address bar and a refresh
  // doesn't re-process the tokens.
  history.replaceState(null, '', window.location.pathname);
  showToast('Signed in via recovery link. Set a new password.', 'success');
  showStep('newpass');
  return true;
}

// Try the hash first. If nothing matched, the async session check above
// will also redirect signed-in users. Otherwise the email form shows.
handleHashSession().then((handled) => {
  if (!handled) {
    // No hash, and the async session check above hasn't redirected —
    // show the email form. (If the user happens to be signed in, the
    // session check will swap to the new-password form once it resolves.)
    if (!document.querySelector('.reset-step:not(.hidden)')) showStep('request');
  }
});

// ============================================================
// Step 1: request the recovery email
// ============================================================
requestForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError(requestForm, '');
  const email = stepEl('reset-email').value.trim();
  if (!email) return showError(requestForm, 'Email is required.');
  setBusy(requestForm, true);
  try {
    await requestRecoveryCode(email);
    pendingEmail = email;
    showToast('Recovery link sent — check your inbox.', 'success');
    showStep('newpass');
    // Re-fill the (hidden) email field so a "send a new link" action
    // could re-use it later without the user retyping.
    stepEl('reset-email').value = email;
  } catch (e) {
    // Supabase rate-limits recovery emails to ~4/hour per email.
    // Translate the cryptic 429 into a friendlier hint.
    const msg = String(e?.message || e || '');
    if (/rate|over_email_send_rate_limit|429/i.test(msg)) {
      showError(requestForm, 'Too many recovery emails sent. Wait an hour and try again.');
    } else {
      showError(requestForm, msg || 'Could not send recovery link.');
    }
  } finally {
    setBusy(requestForm, false);
  }
});

// ============================================================
// Step 2: set the new password, sign out, redirect to login
// ============================================================
newpassForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError(newpassForm, '');
  const pw = stepEl('reset-new-password').value;
  const confirm = stepEl('reset-confirm-password').value;
  if (pw.length < 8) return showError(newpassForm, 'Password must be at least 8 characters.');
  if (pw !== confirm) return showError(newpassForm, 'Passwords do not match.');
  setBusy(newpassForm, true);
  try {
    await updateOwnPassword(pw);
    await supabase.auth.signOut();
    showToast('Password updated. Please sign in.', 'success');
    setTimeout(() => { window.location.replace('./login.html'); }, 600);
  } catch (e) {
    showError(newpassForm, e.message || 'Could not update password.');
    setBusy(newpassForm, false);
  }
});