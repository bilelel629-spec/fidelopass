import { supabase } from './supabase';

export async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) return null;
  return session;
}

export async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) return null;
  return user;
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

/** Vérifie si l'utilisateur est super admin (par email) */
export function isSuperAdmin(email: string | undefined): boolean {
  const builtInAdmins = ['bilelel@live.fr'];
  const adminEmails = Array.from(new Set([...builtInAdmins, ...(import.meta.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e: string) => e.trim())
    .filter(Boolean)]));
  return adminEmails.includes(email ?? '');
}
