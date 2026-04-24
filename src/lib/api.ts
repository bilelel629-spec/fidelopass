import { supabase } from './supabase';
import { withTimeout } from './utils/with-timeout';

const API_URL = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:3001';
const SESSION_PROBE_TIMEOUT_MS = Number(import.meta.env.PUBLIC_AUTH_SESSION_PROBE_TIMEOUT_MS ?? 900);
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

function clearActivePointVenteId() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ACTIVE_POINT_VENTE_STORAGE_KEY);
  } catch {
    // best effort
  }
}

function buildHeaders(opts: RequestInit, activePointVenteId: string | null, accessToken: string | null) {
  const headers = new Headers(opts.headers ?? {});
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${accessToken ?? ''}`);
  }
  if (!headers.has('Content-Type') && !(opts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (activePointVenteId) {
    headers.set(POINT_VENTE_HEADER_NAME, activePointVenteId);
  }
  return headers;
}

async function getAccessTokenFast(): Promise<string | null> {
  const sessionResult = await withTimeout(supabase.auth.getSession(), SESSION_PROBE_TIMEOUT_MS).catch(() => null);
  const token = sessionResult?.data?.session?.access_token ?? null;
  if (token) return token;

  const refreshResult = await withTimeout(supabase.auth.refreshSession(), SESSION_PROBE_TIMEOUT_MS).catch(() => null);
  return refreshResult?.data?.session?.access_token ?? null;
}

/** Wrapper fetch authentifié (ajoute le JWT Supabase automatiquement) */
export async function authFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const accessToken = await getAccessTokenFast();
  const activePointVenteId = getActivePointVenteId();
  const method = String(opts.method ?? 'GET').toUpperCase();
  const url = `${API_URL}${path}`;

  let response = await fetch(url, {
    ...opts,
    headers: buildHeaders(opts, activePointVenteId, accessToken),
  });

  // Si le point de vente stocké est obsolète, on retente une seule fois sans forcer d'id.
  if (activePointVenteId && (method === 'GET' || method === 'HEAD') && (response.status === 403 || response.status === 404)) {
    clearActivePointVenteId();
    response = await fetch(url, {
      ...opts,
      headers: buildHeaders(opts, null, accessToken),
    });
  }

  return response;
}
