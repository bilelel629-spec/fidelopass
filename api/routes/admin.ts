import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { z } from 'zod';
import { getEffectivePlanRaw } from '../utils/effective-plan';
import { appendAdminAuditLog, listAdminAuditLogs } from '../services/admin-audit';

export const adminRoutes = new Hono();

adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', adminMiddleware);

adminRoutes.get('/audit-logs', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 20);
  const data = await listAdminAuditLogs(limitRaw);
  return c.json({ data });
});

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
    db.from('commerces').select('id, plan, plan_override, billing_status, cartes(id), clients(id), points_vente(id)'),
  ]);

  const commerceDetails = commerceDetailsRes.data ?? [];
  const onboarding = {
    sansCarte: commerceDetails.filter((commerce) => !commerce.cartes?.length).length,
    cartePrete: commerceDetails.filter((commerce) => commerce.cartes?.length && !commerce.clients?.length).length,
    cartePartagee: commerceDetails.filter((commerce) => commerce.clients?.length).length,
  };

  const planDistribution = commerceDetails.reduce(
    (acc, commerce) => {
      const effectivePlan = getEffectivePlanRaw(commerce);
      if (effectivePlan.includes('sur')) acc.surMesure += 1;
      else if (effectivePlan.includes('pro')) acc.pro += 1;
      else acc.starter += 1;
      return acc;
    },
    { starter: 0, pro: 0, surMesure: 0 },
  );

  const billingDistribution = commerceDetails.reduce(
    (acc, commerce) => {
      const status = String(commerce.billing_status ?? 'unpaid').toLowerCase();
      if (status === 'active') acc.active += 1;
      else if (status === 'trialing') acc.trialing += 1;
      else if (status === 'canceled') acc.canceled += 1;
      else acc.unpaid += 1;
      return acc;
    },
    { active: 0, trialing: 0, unpaid: 0, canceled: 0 },
  );

  const pointsVenteTotal = commerceDetails.reduce((acc, commerce) => acc + (commerce.points_vente?.length ?? 0), 0);
  const pointsVenteAverage = commerceDetails.length > 0
    ? Number((pointsVenteTotal / commerceDetails.length).toFixed(2))
    : 0;

  return c.json({
    totalCommerces: commercesRes.count ?? 0,
    totalCommercesActifs: commercesActifsRes.count ?? 0,
    totalCartes: cartesRes.count ?? 0,
    totalClients: clientsRes.count ?? 0,
    totalTransactions: transactionsRes.count ?? 0,
    nouveaux30J: recentCommercesRes.count ?? 0,
    onboarding,
    plans: planDistribution,
    billing: billingDistribution,
    points_vente: {
      total: pointsVenteTotal,
      average_per_commerce: pointsVenteAverage,
    },
  });
});

/** PATCH /api/admin/commerces/:id — Active/désactive un commerce */
adminRoutes.patch('/commerces/:id', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (typeof body?.actif !== 'boolean') return c.json({ error: 'Paramètre actif requis' }, 400);
  const adminUser = c.get('user');
  const adminUserId = c.get('userId') as string;

  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .update({ actif: body.actif, updated_at: new Date().toISOString() })
    .eq('id', commerceId)
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);

  await appendAdminAuditLog({
    adminUserId,
    adminEmail: adminUser?.email ?? null,
    action: 'commerce.toggle_active',
    targetType: 'commerce',
    targetId: commerceId,
    payload: {
      actif: body.actif,
    },
  });

  return c.json({ data });
});

/** PATCH /api/admin/commerces/:id/plan — Override du plan effectif */
adminRoutes.patch('/commerces/:id/plan', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const adminUser = c.get('user');
  const adminUserId = c.get('userId') as string;
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

  await appendAdminAuditLog({
    adminUserId,
    adminEmail: adminUser?.email ?? null,
    action: 'commerce.plan_override.updated',
    targetType: 'commerce',
    targetId: commerceId,
    payload: {
      plan_override: parsed.data.plan_override,
      effective_plan: getEffectivePlanRaw(data),
    },
  });

  return c.json({
    data: {
      ...data,
      effective_plan: getEffectivePlanRaw(data),
    },
  });
});

const adminCardAssistanceSchema = z.object({
  point_vente_id: z.string().uuid(),
  nom: z.string().min(2).max(255),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(['points', 'tampons']).default('tampons'),
  tampons_total: z.number().int().min(1).max(50).default(10),
  points_par_euro: z.number().min(0.1).max(100).default(1),
  points_recompense: z.number().int().min(1).default(100),
  recompense_description: z.string().max(255).nullable().optional(),
  couleur_fond: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#0f172a'),
  couleur_texte: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#ffffff'),
  couleur_accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#60a5fa'),
  couleur_fond_2: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  gradient_angle: z.number().int().min(0).max(360).default(135),
  pattern_type: z.enum(['none', 'dots', 'waves', 'grid', 'diagonal', 'confetti']).default('none'),
  logo_url: z.string().url().nullable().optional(),
  strip_url: z.string().url().nullable().optional(),
  strip_position: z.string().default('50:50'),
  tampon_icon_url: z.string().url().nullable().optional(),
  tampon_emoji: z.string().max(8).nullable().optional(),
  tampon_icon_scale: z.number().min(0.6).max(1.5).default(1),
  barcode_type: z.enum(['QR', 'PDF417', 'AZTEC', 'CODE128', 'NONE']).default('QR'),
  label_client: z.string().max(50).default('Client'),
  message_geo: z.string().max(255).nullable().optional(),
  welcome_message: z.string().max(180).nullable().optional(),
  success_message: z.string().max(180).nullable().optional(),
});

/** GET /api/admin/commerces/:id/card-assistance — Données d’édition carte (admin) */
adminRoutes.get('/commerces/:id/card-assistance', async (c) => {
  const commerceId = c.req.param('id');
  const db = createServiceClient();

  const [commerceRes, pointsRes, cartesRes] = await Promise.all([
    db
      .from('commerces')
      .select('id, nom, plan, plan_override, actif')
      .eq('id', commerceId)
      .single(),
    db
      .from('points_vente')
      .select('id, nom, principal, actif')
      .eq('commerce_id', commerceId)
      .order('principal', { ascending: false })
      .order('created_at', { ascending: true }),
    db
      .from('cartes')
      .select('*')
      .eq('commerce_id', commerceId),
  ]);

  if (commerceRes.error || !commerceRes.data) {
    return c.json({ error: 'Commerce introuvable.' }, 404);
  }
  if (pointsRes.error) return c.json({ error: 'Impossible de charger les points de vente.' }, 500);
  if (cartesRes.error) return c.json({ error: 'Impossible de charger les cartes.' }, 500);

  return c.json({
    data: {
      commerce: {
        ...commerceRes.data,
        effective_plan: getEffectivePlanRaw(commerceRes.data),
      },
      points_vente: pointsRes.data ?? [],
      cartes: cartesRes.data ?? [],
    },
  });
});

/** PATCH /api/admin/commerces/:id/card-assistance — Édition carte depuis admin */
adminRoutes.patch('/commerces/:id/card-assistance', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = adminCardAssistanceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides.' }, 400);
  }

  const db = createServiceClient();
  const pointVenteId = parsed.data.point_vente_id;

  const { data: pointVente, error: pointError } = await db
    .from('points_vente')
    .select('id, commerce_id')
    .eq('id', pointVenteId)
    .eq('commerce_id', commerceId)
    .single();

  if (pointError || !pointVente) {
    return c.json({ error: 'Point de vente introuvable pour ce commerce.' }, 404);
  }

  const { data: existing } = await db
    .from('cartes')
    .select('id')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId)
    .maybeSingle();

  const payload = {
    nom: parsed.data.nom,
    description: parsed.data.description ?? null,
    type: parsed.data.type,
    tampons_total: parsed.data.tampons_total,
    points_par_euro: parsed.data.points_par_euro,
    points_recompense: parsed.data.points_recompense,
    recompense_description: parsed.data.recompense_description ?? null,
    couleur_fond: parsed.data.couleur_fond,
    couleur_texte: parsed.data.couleur_texte,
    couleur_accent: parsed.data.couleur_accent,
    couleur_fond_2: parsed.data.couleur_fond_2 ?? null,
    gradient_angle: parsed.data.gradient_angle,
    pattern_type: parsed.data.pattern_type,
    logo_url: parsed.data.logo_url ?? null,
    strip_url: parsed.data.strip_url ?? null,
    strip_position: parsed.data.strip_position,
    tampon_icon_url: parsed.data.tampon_icon_url ?? null,
    tampon_emoji: parsed.data.tampon_emoji ?? null,
    tampon_icon_scale: parsed.data.tampon_icon_scale,
    barcode_type: parsed.data.barcode_type,
    label_client: parsed.data.label_client,
    message_geo: parsed.data.message_geo ?? null,
    welcome_message: parsed.data.welcome_message ?? null,
    success_message: parsed.data.success_message ?? null,
    pass_type_id: process.env.APPLE_PASS_TYPE_ID ?? null,
    commerce_id: commerceId,
    point_vente_id: pointVenteId,
    updated_at: new Date().toISOString(),
  };

  let query = existing?.id
    ? db.from('cartes').update(payload).eq('id', existing.id).eq('commerce_id', commerceId)
    : db.from('cartes').insert(payload);

  let result = await query.select().single();
  if (result.error?.message?.includes('column')) {
    const legacyPayload = { ...payload };
    delete (legacyPayload as Record<string, unknown>).tampon_icon_scale;
    query = existing?.id
      ? db.from('cartes').update(legacyPayload).eq('id', existing.id).eq('commerce_id', commerceId)
      : db.from('cartes').insert(legacyPayload);
    result = await query.select().single();
  }

  if (result.error) return c.json({ error: result.error.message }, 500);
  return c.json({ data: result.data });
});
