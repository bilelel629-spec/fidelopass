import { withTimeout } from './utils/with-timeout';

type BillingStatusResponse = {
  data?: {
    has_access?: boolean;
    onboarding_completed?: boolean;
    recommended_redirect?: '/abonnement/choix' | '/onboarding' | '/dashboard';
  };
};

const API_BASE = (import.meta.env.PUBLIC_API_URL || 'https://api.fidelopass.com').replace(/\/$/, '');
const BILLING_CHECK_TIMEOUT_MS = Number(import.meta.env.PUBLIC_BILLING_CHECK_TIMEOUT_MS ?? 2200);
const ACCESS_CHECK_UNCERTAIN_DESTINATION = '/abonnement/choix?verification=1';

function normalizePreferredDestination(value?: string | null) {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;

  try {
    const url = new URL(raw, 'https://www.fidelopass.com');
    const path = `${url.pathname}${url.search}`;
    const allowedExactDestinations = new Set([
      '/onboarding',
      '/app',
      '/dashboard',
      '/admin',
      '/partner',
      '/devenir-revendeur',
    ]);
    const allowedDestinationPrefixes = [
      '/app/',
      '/dashboard/',
      '/admin/',
      '/partner/',
    ];
    const isAllowed =
      allowedExactDestinations.has(url.pathname)
      || allowedDestinationPrefixes.some((prefix) => url.pathname.startsWith(prefix));

    return isAllowed ? path : null;
  } catch {
    return null;
  }
}

export async function resolvePostAuthDestination(
  accessToken: string,
  preferredDestination?: string | null,
): Promise<string> {
  if (!API_BASE || !accessToken) return '/abonnement/choix';

  try {
    const billing = await withTimeout(
      fetch(`${API_BASE}/api/billing/status`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }).then(async (response) => {
        if (response.status === 401) return { __unauthorized: true } as const;
        const payload = await response.json().catch(() => ({} as BillingStatusResponse));
        return { __status: response.status, payload } as const;
      }),
      BILLING_CHECK_TIMEOUT_MS,
    );

    if ('__unauthorized' in billing) return '/login';
    // En cas d'incident API transitoire, ne jamais ouvrir le dashboard par défaut.
    if ((billing.__status ?? 500) >= 500) return ACCESS_CHECK_UNCERTAIN_DESTINATION;

    const data = billing.payload?.data;
    if (!data?.has_access) return '/abonnement/choix';

    const preferred = normalizePreferredDestination(preferredDestination);
    if (!data?.onboarding_completed) return '/dashboard?tour=1';
    return preferred ?? data.recommended_redirect ?? '/dashboard';
  } catch {
    return ACCESS_CHECK_UNCERTAIN_DESTINATION;
  }
}
