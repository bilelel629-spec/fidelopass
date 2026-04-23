import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getBillingStatusForUser } from '../services/billing';

export const billingRoutes = new Hono();

billingRoutes.use('*', authMiddleware);

/** GET /api/billing/status — statut d'accès abonnement pour l'utilisateur connecté */
billingRoutes.get('/status', async (c) => {
  const userId = c.get('userId') as string;
  const data = await getBillingStatusForUser(userId);
  const response = c.json({ data });
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
});
