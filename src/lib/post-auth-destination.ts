type BillingStatusResponse = {
  data?: {
    has_access?: boolean;
    onboarding_completed?: boolean;
  };
};

const API_BASE = (import.meta.env.PUBLIC_API_URL || 'https://api.fidelopass.com').replace(/\/$/, '');
const BILLING_CHECK_TIMEOUT_MS = Number(import.meta.env.PUBLIC_BILLING_CHECK_TIMEOUT_MS ?? 2200);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

export async function resolvePostAuthDestination(accessToken: string): Promise<string> {
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
    if ((billing.__status ?? 500) >= 500) return '/abonnement/choix';

    const data = billing.payload?.data;
    if (!data?.has_access) return '/abonnement/choix';
    return data?.onboarding_completed ? '/dashboard' : '/onboarding';
  } catch {
    return '/abonnement/choix';
  }
}
