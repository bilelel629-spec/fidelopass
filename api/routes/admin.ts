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
      z.literal('auto'),
      z.null(),
    ]),
  }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'plan_override invalide (auto, starter, pro, sur-mesure ou null).' }, 400);
  }

  const nextOverride = parsed.data.plan_override === 'auto' ? null : parsed.data.plan_override;
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .update({
      plan_override: nextOverride,
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
      plan_override: nextOverride,
      effective_plan: getEffectivePlanRaw(data),
      source: nextOverride ? 'admin_override' : 'billing_auto',
    },
  });

  return c.json({
    data: {
      ...data,
      effective_plan: getEffectivePlanRaw(data),
      source: data.plan_override ? 'admin_override' : 'billing_auto',
    },
  });
});

const adminCardAssistanceSchema = z.object({
  point_vente_id: z.string().uuid(),
  nom: z.string().min(2).max(255).optional(),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(['points', 'tampons']).optional(),
  tampons_total: z.number().int().min(1).max(50).optional(),
  points_par_euro: z.number().min(0.1).max(100).optional(),
  points_recompense: z.number().int().min(1).optional(),
  recompense_description: z.string().max(255).nullable().optional(),
  couleur_fond: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  couleur_texte: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  couleur_accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  couleur_fond_2: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  gradient_angle: z.number().int().min(0).max(360).optional(),
  pattern_type: z.enum(['none', 'dots', 'waves', 'grid', 'diagonal', 'confetti']).optional(),
  logo_url: z.string().trim().refine((value) => {
    if (value.startsWith('/')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, { message: 'URL média invalide' }).nullable().optional(),
  strip_url: z.string().trim().refine((value) => {
    if (value.startsWith('/')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, { message: 'URL média invalide' }).nullable().optional(),
  strip_position: z.string().optional(),
  tampon_icon_url: z.string().trim().refine((value) => {
    if (value.startsWith('/')) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, { message: 'URL média invalide' }).nullable().optional(),
  tampon_emoji: z.string().max(8).nullable().optional(),
  tampon_icon_scale: z.number().min(0.6).max(1.5).optional(),
  barcode_type: z.enum(['QR', 'PDF417', 'AZTEC', 'CODE128', 'NONE']).optional(),
  label_client: z.string().max(50).optional(),
  message_geo: z.string().max(255).nullable().optional(),
  welcome_message: z.string().max(180).nullable().optional(),
  success_message: z.string().max(180).nullable().optional(),
});

const adminCardProposalSchema = adminCardAssistanceSchema.extend({
  submit_for_validation: z.boolean().optional().default(false),
  admin_note: z.string().max(500).nullable().optional(),
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

/** GET /api/admin/commerces/:id/card-assistance/proposal — Dernière proposition admin (draft/pending) */
adminRoutes.get('/commerces/:id/card-assistance/proposal', async (c) => {
  const commerceId = c.req.param('id');
  const pointVenteId = c.req.query('point_vente_id');
  if (!pointVenteId) return c.json({ error: 'point_vente_id requis.' }, 400);

  const db = createServiceClient();
  const { data: proposal, error } = await db
    .from('admin_card_proposals')
    .select('*')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId)
    .in('status', ['draft_admin', 'pending_merchant'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return c.json({ error: 'Impossible de charger la proposition.' }, 500);
  return c.json({ data: proposal ?? null });
});

/** POST /api/admin/commerces/:id/card-assistance/proposal — Brouillon/soumission commerçant */
adminRoutes.post('/commerces/:id/card-assistance/proposal', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const adminUser = c.get('user');
  const adminUserId = c.get('userId') as string;
  const parsed = adminCardProposalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides.' }, 400);
  }

  const db = createServiceClient();
  const input = parsed.data;

  const { data: pointVente, error: pointError } = await db
    .from('points_vente')
    .select('id, commerce_id')
    .eq('id', input.point_vente_id)
    .eq('commerce_id', commerceId)
    .single();

  if (pointError || !pointVente) {
    return c.json({ error: 'Point de vente introuvable pour ce commerce.' }, 404);
  }

  const { data: existingCard } = await db
    .from('cartes')
    .select('id')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', input.point_vente_id)
    .maybeSingle();

  const proposalPayload: Record<string, unknown> = {};
  const assignIfDefined = (key: keyof typeof input, column: string = key) => {
    const value = input[key];
    if (value !== undefined) proposalPayload[column] = value;
  };

  assignIfDefined('nom');
  assignIfDefined('description');
  assignIfDefined('type');
  assignIfDefined('tampons_total');
  assignIfDefined('points_par_euro');
  assignIfDefined('points_recompense');
  assignIfDefined('recompense_description');
  assignIfDefined('couleur_fond');
  assignIfDefined('couleur_texte');
  assignIfDefined('couleur_accent');
  assignIfDefined('couleur_fond_2');
  assignIfDefined('gradient_angle');
  assignIfDefined('pattern_type');
  assignIfDefined('logo_url');
  assignIfDefined('strip_url');
  assignIfDefined('strip_position');
  assignIfDefined('tampon_icon_url');
  assignIfDefined('tampon_emoji');
  assignIfDefined('tampon_icon_scale');
  assignIfDefined('barcode_type');
  assignIfDefined('label_client');
  assignIfDefined('message_geo');
  assignIfDefined('welcome_message');
  assignIfDefined('success_message');

  if (!existingCard?.id && !proposalPayload.nom) {
    return c.json({ error: 'Le nom de carte est obligatoire pour créer une carte via proposition.' }, 400);
  }

  const nowIso = new Date().toISOString();
  const nextStatus = input.submit_for_validation ? 'pending_merchant' : 'draft_admin';

  const { data: openProposal } = await db
    .from('admin_card_proposals')
    .select('id')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', input.point_vente_id)
    .in('status', ['draft_admin', 'pending_merchant'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const baseProposal = {
    commerce_id: commerceId,
    point_vente_id: input.point_vente_id,
    carte_id: existingCard?.id ?? null,
    payload: proposalPayload,
    admin_note: input.admin_note ?? null,
    status: nextStatus,
    updated_at: nowIso,
    ...(input.submit_for_validation ? { submitted_at: nowIso } : {}),
  };

  const result = openProposal?.id
    ? await db.from('admin_card_proposals').update(baseProposal).eq('id', openProposal.id).select('*').single()
    : await db.from('admin_card_proposals').insert({
      ...baseProposal,
      created_by_admin_user_id: adminUserId,
      created_by_admin_email: adminUser?.email ?? null,
      created_at: nowIso,
    }).select('*').single();

  if (result.error) return c.json({ error: result.error.message }, 500);

  await appendAdminAuditLog({
    adminUserId,
    adminEmail: adminUser?.email ?? null,
    action: input.submit_for_validation ? 'commerce.card_proposal.submitted' : 'commerce.card_proposal.saved',
    targetType: 'commerce',
    targetId: commerceId,
    payload: {
      proposal_id: result.data?.id ?? null,
      point_vente_id: input.point_vente_id,
      changed_fields: Object.keys(proposalPayload),
      status: nextStatus,
    },
  });

  return c.json({ data: result.data });
});

/** PATCH /api/admin/commerces/:id/card-assistance — Édition carte depuis admin */
adminRoutes.patch('/commerces/:id/card-assistance', async (c) => {
  const commerceId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const adminUser = c.get('user');
  const adminUserId = c.get('userId') as string;
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
    .select('*')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId)
    .maybeSingle();
  const input = parsed.data;
  if (!existing && !input.nom) {
    return c.json({ error: 'Le nom de la carte est obligatoire pour créer une carte.' }, 400);
  }

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (!existing) {
    payload.commerce_id = commerceId;
    payload.point_vente_id = pointVenteId;
    payload.pass_type_id = process.env.APPLE_PASS_TYPE_ID ?? null;
    payload.nom = input.nom ?? 'Carte fidélité';
    payload.type = input.type ?? 'tampons';
    payload.tampons_total = input.tampons_total ?? 10;
    payload.points_par_euro = input.points_par_euro ?? 1;
    payload.points_recompense = input.points_recompense ?? 100;
    payload.couleur_fond = input.couleur_fond ?? '#0f172a';
    payload.couleur_texte = input.couleur_texte ?? '#ffffff';
    payload.couleur_accent = input.couleur_accent ?? '#60a5fa';
    payload.gradient_angle = input.gradient_angle ?? 135;
    payload.pattern_type = input.pattern_type ?? 'none';
    payload.strip_position = input.strip_position ?? '50:50';
    payload.barcode_type = input.barcode_type ?? 'QR';
    payload.label_client = input.label_client ?? 'Client';
    payload.tampon_icon_scale = input.tampon_icon_scale ?? 1;
  }

  const assignIfDefined = (key: keyof typeof input, column: string = key) => {
    const value = input[key];
    if (value !== undefined) payload[column] = value;
  };

  assignIfDefined('nom');
  assignIfDefined('description');
  assignIfDefined('type');
  assignIfDefined('tampons_total');
  assignIfDefined('points_par_euro');
  assignIfDefined('points_recompense');
  assignIfDefined('recompense_description');
  assignIfDefined('couleur_fond');
  assignIfDefined('couleur_texte');
  assignIfDefined('couleur_accent');
  assignIfDefined('couleur_fond_2');
  assignIfDefined('gradient_angle');
  assignIfDefined('pattern_type');
  assignIfDefined('logo_url');
  assignIfDefined('strip_url');
  assignIfDefined('strip_position');
  assignIfDefined('tampon_icon_url');
  assignIfDefined('tampon_emoji');
  assignIfDefined('tampon_icon_scale');
  assignIfDefined('barcode_type');
  assignIfDefined('label_client');
  assignIfDefined('message_geo');
  assignIfDefined('welcome_message');
  assignIfDefined('success_message');

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

  await appendAdminAuditLog({
    adminUserId,
    adminEmail: adminUser?.email ?? null,
    action: existing?.id ? 'commerce.card_assistance.updated' : 'commerce.card_assistance.created',
    targetType: 'commerce',
    targetId: commerceId,
    payload: {
      point_vente_id: pointVenteId,
      carte_id: result.data?.id ?? existing?.id ?? null,
      changed_fields: Object.keys(payload).filter((field) => !['updated_at', 'commerce_id', 'point_vente_id'].includes(field)),
    },
  });

  return c.json({ data: result.data });
});
