import { supabase } from './supabase';
import { clearSessionCookie, setSessionCookie } from './session-cookie';
import { withTimeout } from './utils/with-timeout';

const SESSION_PROBE_TIMEOUT_MS = Number(import.meta.env.PUBLIC_AUTH_SESSION_PROBE_TIMEOUT_MS ?? 2500);

export async function getSession() {
  const sessionResult = await withTimeout(supabase.auth.getSession(), SESSION_PROBE_TIMEOUT_MS).catch(() => null);
  if (!sessionResult) return null;
  const { data: { session }, error } = sessionResult;
  if (!error && session) return session;

  const refreshResult = await withTimeout(supabase.auth.refreshSession(), SESSION_PROBE_TIMEOUT_MS).catch(() => null);
  if (!refreshResult) return null;
  const { data, error: refreshError } = refreshResult;
  if (refreshError) return null;
  return data.session ?? null;
}

export async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) return null;
  return user;
}

export async function signIn(email: string, password: string) {
  const result = await supabase.auth.signInWithPassword({ email, password });
  const token = result.data.session?.access_token;
  if (token) setSessionCookie(token);
  return result;
}

export async function signUp(email: string, password: string) {
  const result = await supabase.auth.signUp({ email, password });
  const token = result.data.session?.access_token;
  if (token) setSessionCookie(token);
  return result;
}

export async function signOut() {
  clearSessionCookie();
  return supabase.auth.signOut();
}

/** Vérifie si l'utilisateur est super admin (par email) */
export function isSuperAdmin(email: string | undefined): boolean {
  const builtInAdmins = ['bilelel@live.fr', 'bilelel629@gmail.com'];
  const adminEmails = Array.from(new Set([...builtInAdmins, ...(import.meta.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e: string) => e.trim())
    .filter(Boolean)]));
  return adminEmails.includes(email ?? '');
}
