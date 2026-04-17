import type { Context, Next } from 'hono';
import { getBillingStatusForUser } from '../services/billing';

export async function paidMiddleware(c: Context, next: Next) {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'Utilisateur non authentifié' }, 401);
  }

  const status = await getBillingStatusForUser(userId);
  if (!status.has_access) {
    return c.json({
      error: 'Abonnement requis pour accéder à cette fonctionnalité.',
      code: 'SUBSCRIPTION_REQUIRED',
      billing: status,
    }, 402);
  }

  c.set('billing', status);
  await next();
}
