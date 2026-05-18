import { supabase } from './supabase';
import { getFreshSession } from './session-guard';

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
  const session = await getFreshSession(supabase);
  const activePointVenteId = getActivePointVenteId();
  const request = (accessToken: string) => fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      ...(activePointVenteId ? { [POINT_VENTE_HEADER_NAME]: activePointVenteId } : {}),
    },
  });

  const response = await request(session?.access_token ?? '');
  if (response.status !== 401) return response;

  const refreshed = await supabase.auth.refreshSession();
  const accessToken = refreshed.data.session?.access_token;
  if (!accessToken) return response;

  return request(accessToken);
}
