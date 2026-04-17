import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getBillingStatusForUser } from '../services/billing';

export const billingRoutes = new Hono();

billingRoutes.use('*', authMiddleware);

/** GET /api/billing/status — statut d'accès abonnement pour l'utilisateur connecté */
billingRoutes.get('/status', async (c) => {
  const userId = c.get('userId') as string;
  const data = await getBillingStatusForUser(userId);
  return c.json({ data });
});
