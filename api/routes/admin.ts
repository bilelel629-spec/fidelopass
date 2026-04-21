import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { z } from 'zod';
import { getEffectivePlanRaw } from '../utils/effective-plan';

export const adminRoutes = new Hono();

adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', adminMiddleware);

/** GET /api/admin/commerces — Liste tous les commerces */
adminRoutes.get('/commerces', async (c) => {
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .select('*, cartes(id, nom, updated_at), clients(id)')
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: 'Erreur lors de la récupération' }, 500);

  const normalized = (data ?? []).map((commerce) => ({
    ...commerce,
    effective_plan: getEffectivePlanRaw(commerce),
  }));

  return c.json({ data: normalized });
});

/** GET /api/admin/stats — Stats globales de la plateforme */
adminRoutes.get('/stats', async (c) => {
  const db = createServiceClient();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [commercesRes, commercesActifsRes, cartesRes, clientsRes, transactionsRes, recentCommercesRes, commerceDetailsRes] = await Promise.all([
    db.from('commerces').select('id', { count: 'exact', head: true }),
    db.from('commerces').select('id', { count: 'exact', head: true }).eq('actif', true),
    db.from('cartes').select('id', { count: 'exact', head: true }),
    db.from('clients').select('id', { count: 'exact', head: true }),
    db.from('transactions').select('id', { count: 'exact', head: true }),
    db.from('commerces').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo.toISOString()),
    db.from('commerces').select('id, cartes(id), clients(id)'),
  ]);

  const commerceDetails = commerceDetailsRes.data ?? [];
  const onboarding = {
    sansCarte: commerceDetails.filter((commerce) => !commerce.cartes?.length).length,
    cartePrete: commerceDetails.filter((commerce) => commerce.cartes?.length && !commerce.clients?.length).length,
    cartePartagee: commerceDetails.filter((commerce) => commerce.clients?.length).length,
  };

  return c.json({
    totalCommerces: commercesRes.count ?? 0,
    totalCommercesActifs: commercesActifsRes.count ?? 0,
    totalCartes: cartesRes.count ?? 0,
    totalClients: clientsRes.count ?? 0,
    totalTransactions: transactionsRes.count ?? 0,
    nouveaux30J: recentCommercesRes.count ?? 0,
    onboarding,
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

/** PATCH /api/admin/commerces/:id/plan — Override du plan effectif */
adminRoutes.patch('/commerces/:id/plan', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    plan_override: z.union([
      z.literal('starter'),
      z.literal('pro'),
      z.literal('sur-mesure'),
      z.null(),
    ]),
  }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'plan_override invalide (starter, pro, sur-mesure ou null).' }, 400);
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .update({
      plan_override: parsed.data.plan_override,
      updated_at: new Date().toISOString(),
    })
    .eq('id', commerceId)
    .select('id, plan, plan_override')
    .single();

  if (error) return c.json({ error: 'Erreur lors de la mise à jour du plan.' }, 500);

  return c.json({
    data: {
      ...data,
      effective_plan: getEffectivePlanRaw(data),
    },
  });
});
