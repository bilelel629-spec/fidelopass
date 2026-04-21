import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { getPlanLimits, normalizePlan } from './commerces';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

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

  const effectivePlan = getEffectivePlanRaw(commerce);
  const limits = getPlanLimits(effectivePlan);
  const normalizedPlan = normalizePlan(effectivePlan);

  const { count: clientsCount } = await db
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente?.id ?? '');

  return c.json({
    data: {
      plan: normalizedPlan,
      raw_plan: commerce.plan ?? 'starter',
      plan_override: commerce.plan_override ?? null,
      normalized_plan: normalizedPlan,
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

/** GET /api/dashboard/retention — Rétention hebdomadaire (clients revenants) */
dashboardRoutes.get('/retention', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ data: [], summary: { rate_30d: 0, repeat_30d: 0, active_30d: 0 } });

  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - 55);
  since.setHours(0, 0, 0, 0);

  const { data: transactions } = await db
    .from('transactions')
    .select('client_id, created_at')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });

  const weekBuckets = new Map<string, Map<string, number>>();
  const startOfWeek = (value: Date) => {
    const d = new Date(value);
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const toKey = (value: Date) => value.toISOString().slice(0, 10);

  for (const tx of transactions ?? []) {
    const txDate = new Date(tx.created_at);
    const key = toKey(startOfWeek(txDate));
    const week = weekBuckets.get(key) ?? new Map<string, number>();
    week.set(tx.client_id, (week.get(tx.client_id) ?? 0) + 1);
    weekBuckets.set(key, week);
  }

  const orderedWeeks: string[] = [];
  for (let i = 7; i >= 0; i--) {
    const base = new Date(now);
    base.setDate(base.getDate() - i * 7);
    orderedWeeks.push(toKey(startOfWeek(base)));
  }

  const data = orderedWeeks.map((key) => {
    const week = weekBuckets.get(key) ?? new Map<string, number>();
    const active = week.size;
    let repeat = 0;
    week.forEach((count) => {
      if (count >= 2) repeat += 1;
    });
    return {
      week_start: key,
      active_clients: active,
      repeat_clients: repeat,
      retention_rate: active > 0 ? Math.round((repeat / active) * 100) : 0,
    };
  });

  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const active30 = new Map<string, number>();
  for (const tx of transactions ?? []) {
    const txDate = new Date(tx.created_at);
    if (txDate < thirtyDaysAgo) continue;
    active30.set(tx.client_id, (active30.get(tx.client_id) ?? 0) + 1);
  }
  let repeat30 = 0;
  active30.forEach((count) => {
    if (count >= 2) repeat30 += 1;
  });

  return c.json({
    data,
    summary: {
      active_30d: active30.size,
      repeat_30d: repeat30,
      rate_30d: active30.size > 0 ? Math.round((repeat30 / active30.size) * 100) : 0,
    },
  });
});

/** GET /api/dashboard/tour-status — Tutoriel première connexion */
dashboardRoutes.get('/tour-status', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const { commerce } = await resolveCommerceAndPointVente(
    db,
    userId,
    null,
    'id, dashboard_tour_seen',
  );

  return c.json({
    data: {
      seen: Boolean((commerce as { dashboard_tour_seen?: boolean | null } | null)?.dashboard_tour_seen),
    },
  });
});

/** PATCH /api/dashboard/tour-status — Marque le tutoriel comme vu */
dashboardRoutes.patch('/tour-status', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const body = await c.req.json().catch(() => null);
  const seen = Boolean(body?.seen ?? true);

  const { commerce } = await resolveCommerceAndPointVente(
    db,
    userId,
    null,
    'id',
  );

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { error } = await db
    .from('commerces')
    .update({ dashboard_tour_seen: seen, updated_at: new Date().toISOString() })
    .eq('id', commerce.id);

  if (error) return c.json({ error: 'Impossible de mettre à jour le tutoriel.' }, 500);

  return c.json({ ok: true, data: { seen } });
});
