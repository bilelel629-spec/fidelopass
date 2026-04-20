import { supabase } from './supabase';

const API_URL = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:3001';
export const ACTIVE_POINT_VENTE_STORAGE_KEY = 'fidelopass_active_point_vente_id';
export const POINT_VENTE_HEADER_NAME = 'X-Point-Vente-Id';

function getActivePointVenteId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(ACTIVE_POINT_VENTE_STORAGE_KEY)?.trim() ?? '';
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Wrapper fetch authentifié (ajoute le JWT Supabase automatiquement) */
export async function authFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const activePointVenteId = getActivePointVenteId();
  return fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${session?.access_token ?? ''}`,
      ...(activePointVenteId ? { [POINT_VENTE_HEADER_NAME]: activePointVenteId } : {}),
    },
  });
}
