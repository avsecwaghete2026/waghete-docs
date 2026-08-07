// Auth helpers + role lookup. The role is fetched once after login and
// cached on window.__sessionRole__ for the lifetime of the page.

import { supabase } from './supabaseClient.js';

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function loadProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function ensureRole() {
  const session = await getSession();
  if (!session) return null;
  try {
    const profile = await loadProfile(session.user.id);
    window.__sessionRole__ = profile.role;
    window.__sessionEmail__ = profile.email;
    return profile;
  } catch (e) {
    // Profile missing or unreadable — the session is unusable. Clear it
    // so getSession() returns null next time and the user gets bounced
    // to login instead of staring at an empty navbar.
    console.warn('Profile load failed, clearing session:', e);
    window.__sessionRole__ = null;
    window.__sessionEmail__ = null;
    await signOut().catch(() => {});
    return null;
  }
}

export function isAdmin() {
  return window.__sessionRole__ === 'admin';
}