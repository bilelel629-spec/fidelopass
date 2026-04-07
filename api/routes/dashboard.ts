import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';

export const dashboardRoutes = new Hono();

dashboardRoutes.use('*', authMiddleware);

/** GET /api/dashboard/stats */
dashboardRoutes.get('/stats', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) {
    return c.json({ totalClients: 0, scansAujourdhui: 0, totalRecompenses: 0, clientsPushActifs: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const [clientsRes, scansRes, recompensesRes, pushRes] = await Promise.all([
    db.from('clients').select('id', { count: 'exact', head: true }).eq('commerce_id', commerce.id),
    db.from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .gte('created_at', today),
    db.from('clients').select('recompenses_obtenues').eq('commerce_id', commerce.id),
    db.from('clients').select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .eq('push_enabled', true),
  ]);

  const totalRecompenses = (recompensesRes.data ?? []).reduce(
    (acc, row) => acc + row.recompenses_obtenues, 0
  );

  return c.json({
    totalClients: clientsRes.count ?? 0,
    scansAujourdhui: scansRes.count ?? 0,
    totalRecompenses,
    clientsPushActifs: pushRes.count ?? 0,
  });
});
