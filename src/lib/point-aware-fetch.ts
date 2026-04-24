import { withTimeout } from './utils/with-timeout';

export type AuthFetchFn = (path: string, init?: RequestInit) => Promise<Response>;

export type PointAwareFetchOptions = {
  storageKey?: string;
  timeoutMs?: number;
};

function safeReadStorage(storageKey: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(storageKey)?.trim() ?? '';
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function getStoredPointVenteId(storageKey: string): string | null {
  return safeReadStorage(storageKey);
}

export function clearStoredPointVenteId(storageKey: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // best effort
  }
}

export function withPointVenteQuery(path: string, storageKey: string): string {
  const pointVenteId = safeReadStorage(storageKey);
  if (!pointVenteId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}point_vente_id=${encodeURIComponent(pointVenteId)}`;
}

export async function pointAwareFetch(
  authFetch: AuthFetchFn,
  path: string,
  init?: RequestInit,
  options: PointAwareFetchOptions = {},
): Promise<Response> {
  const storageKey = options.storageKey ?? 'fidelopass_active_point_vente_id';
  const timeoutMs = Number(options.timeoutMs ?? 3500);
  const url = withPointVenteQuery(path, storageKey);
  const firstRequest = authFetch(url, init);
  const firstResponse = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? await withTimeout(firstRequest, timeoutMs)
    : await firstRequest;

  if (firstResponse.status !== 403 && firstResponse.status !== 404) return firstResponse;

  const currentPointId = getStoredPointVenteId(storageKey);
  if (!currentPointId) return firstResponse;

  clearStoredPointVenteId(storageKey);
  const retryRequest = authFetch(path, init);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? withTimeout(retryRequest, timeoutMs)
    : retryRequest;
}

