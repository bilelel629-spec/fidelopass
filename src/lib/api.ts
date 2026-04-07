import { supabase } from './supabase';

const API_URL = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:3001';

/** Wrapper fetch authentifié (ajoute le JWT Supabase automatiquement) */
export async function authFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${session?.access_token ?? ''}`,
    },
  });
}
