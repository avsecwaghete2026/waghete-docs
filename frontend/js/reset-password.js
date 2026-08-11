// Reset password page — three-step flow:
//   1. request: send recovery code via Supabase OTP
//   2. verify:  collect the code, verify (Supabase creates a session)
//   3. set new password, sign out, redirect to login

import { getSession } from './auth.js';
import { requestRecoveryCode, verifyRecoveryCode, updateOwnPassword } from './api.js';
import { supabase } from './supabaseClient.js';
import { showToast } from './toast.js';

const stepEl = (id) => document.getElementById(id);
const requestForm = stepEl('reset-request-form');
const verifyForm  = stepEl('reset-verify-form');
const newpassForm  = stepEl('reset-newpass-form');
const subtitle     = stepEl('step-subtitle');

// If the user is already signed in, send them to the app.
getSession().then((s) => { if (s) window.location.replace('./index.html'); });

let pendingEmail = '';

function showStep(name) {
  for (const f of [requestForm, verifyForm, newpassForm]) {
    f.classList.toggle('hidden', f !== stepEl(name));
  }
  if (name === 'request') {
    subtitle.textContent = 'Enter the email on your account.';
    requestForm.querySelector('input').focus();
  } else if (name === 'verify') {
    subtitle.textContent = `Enter the code we sent to ${pendingEmail}.`;
    verifyForm.querySelector('input').focus();
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
// Step 1: request the recovery code
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
    showToast('Recovery code sent — check your inbox.', 'success');
    showStep('verify');
  } catch (e) {
    showError(requestForm, e.message || 'Could not send recovery code.');
  } finally {
    setBusy(requestForm, false);
  }
});

// ============================================================
// Step 2: verify the code (creates a session)
// ============================================================
verifyForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError(verifyForm, '');
  const code = stepEl('reset-code').value.trim();
  if (!/^\d{6}$/.test(code)) {
    return showError(verifyForm, 'Enter the 6-digit code from your email.');
  }
  setBusy(verifyForm, true);
  try {
    await verifyRecoveryCode(pendingEmail, code);
    showStep('newpass');
  } catch (e) {
    showError(verifyForm, e.message || 'Code is invalid or expired.');
  } finally {
    setBusy(verifyForm, false);
  }
});

// "Send a new code" — re-runs step 1 but keeps the email filled in.
stepEl('reset-resend-link').addEventListener('click', async (ev) => {
  ev.preventDefault();
  if (!pendingEmail) {
    showStep('request');
    return;
  }
  try {
    await requestRecoveryCode(pendingEmail);
    showToast('A new code has been sent.', 'success');
  } catch (e) {
    showError(verifyForm, e.message || 'Could not resend the code.');
  }
});

// ============================================================
// Step 3: set the new password, sign out, redirect to login
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
    // Sign the recovery session out so the user lands at the login
    // screen and signs in with their new password.
    await supabase.auth.signOut();
    showToast('Password updated. Please sign in.', 'success');
    // Small delay so the toast is visible before the navigation.
    setTimeout(() => { window.location.replace('./login.html'); }, 600);
  } catch (e) {
    showError(newpassForm, e.message || 'Could not update password.');
    setBusy(newpassForm, false);
  }
});