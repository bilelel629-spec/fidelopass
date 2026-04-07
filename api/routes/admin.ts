import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

export const adminRoutes = new Hono();

adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', adminMiddleware);

/** GET /api/admin/commerces — Liste tous les commerces */
adminRoutes.get('/commerces', async (c) => {
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .select('*, cartes(id), clients(id)')
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: 'Erreur lors de la récupération' }, 500);

  return c.json({ data });
});

/** GET /api/admin/stats — Stats globales de la plateforme */
adminRoutes.get('/stats', async (c) => {
  const db = createServiceClient();

  const [commercesRes, cartesRes, clientsRes, transactionsRes] = await Promise.all([
    db.from('commerces').select('id', { count: 'exact', head: true }),
    db.from('cartes').select('id', { count: 'exact', head: true }),
    db.from('clients').select('id', { count: 'exact', head: true }),
    db.from('transactions').select('id', { count: 'exact', head: true }),
  ]);

  return c.json({
    totalCommerces: commercesRes.count ?? 0,
    totalCartes: cartesRes.count ?? 0,
    totalClients: clientsRes.count ?? 0,
    totalTransactions: transactionsRes.count ?? 0,
  });
});

/** PATCH /api/admin/commerces/:id — Active/désactive un commerce */
adminRoutes.patch('/commerces/:id', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (typeof body?.actif !== 'boolean') return c.json({ error: 'Paramètre actif requis' }, 400);

  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .update({ actif: body.actif, updated_at: new Date().toISOString() })
    .eq('id', commerceId)
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);

  return c.json({ data });
});
