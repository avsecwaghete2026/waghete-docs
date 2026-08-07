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
  const profile = await loadProfile(session.user.id);
  window.__sessionRole__ = profile.role;
  window.__sessionEmail__ = profile.email;
  return profile;
}

export function isAdmin() {
  return window.__sessionRole__ === 'admin';
}