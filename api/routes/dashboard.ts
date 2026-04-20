import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { getPlanLimits } from './commerces';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';

export const dashboardRoutes = new Hono();

dashboardRoutes.use('*', authMiddleware);
dashboardRoutes.use('*', paidMiddleware);

/** GET /api/dashboard/stats */
dashboardRoutes.get('/stats', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) {
    return c.json({ totalClients: 0, scansAujourdhui: 0, totalRecompenses: 0, clientsPushActifs: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const [clientsRes, scansRes, recompensesRes, pushRes] = await Promise.all([
    db.from('clients').select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id),
    db.from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .gte('created_at', today),
    db.from('clients').select('recompenses_obtenues')
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id),
    db.from('clients').select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
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

/** GET /api/dashboard/plan — Plan actif et limites */
dashboardRoutes.get('/plan', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente, pointsVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce) return c.json({ data: { plan: 'starter', limits: getPlanLimits('starter'), clientsCount: 0 } });

  const limits = getPlanLimits(commerce.plan);

  const { count: clientsCount } = await db
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente?.id ?? '');

  return c.json({
    data: {
      plan: commerce.plan ?? 'starter',
      limits,
      clientsCount: clientsCount ?? 0,
      pointsVenteCount: pointsVente.length,
      selectedPointVenteId: pointVente?.id ?? null,
    },
  });
});

/** GET /api/dashboard/weekly-scans — Scans par jour sur les 7 derniers jours */
dashboardRoutes.get('/weekly-scans', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ data: [] });

  const since = new Date();
  since.setDate(since.getDate() - 6);
  since.setHours(0, 0, 0, 0);

  const { data: transactions } = await db
    .from('transactions')
    .select('created_at, type')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });

  // Agrège par jour
  const days: Record<string, { scans: number; recompenses: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days[d.toISOString().slice(0, 10)] = { scans: 0, recompenses: 0 };
  }

  for (const tx of transactions ?? []) {
    const day = tx.created_at.slice(0, 10);
    if (days[day]) {
      if (tx.type === 'recompense') days[day].recompenses++;
      else days[day].scans++;
    }
  }

  return c.json({
    data: Object.entries(days).map(([date, counts]) => ({ date, ...counts })),
  });
});
