import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { partnerMiddleware, type PartnerContext } from '../middleware/partner';

export const partnerRoutes = new Hono();

const partnerBrandingSchema = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  logo_url: z.string().trim().max(1000).nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  support_email: z.string().trim().email().nullable().optional(),
  support_phone: z.string().trim().max(50).nullable().optional(),
  website_url: z.string().trim().max(1000).nullable().optional(),
  white_label_enabled: z.boolean().optional(),
  hide_fidelopass_branding: z.boolean().optional(),
});

const partnerCommerceCreateSchema = z.object({
  owner_user_id: z.string().uuid().optional(),
  owner_email: z.string().trim().email().optional(),
  nom: z.string().trim().min(2).max(255),
  email: z.string().trim().email().nullable().optional(),
  telephone: z.string().trim().max(50).nullable().optional(),
  adresse: z.string().trim().max(500).nullable().optional(),
}).refine((value) => Boolean(value.owner_user_id || value.owner_email), {
  message: 'Renseignez l’email ou l’UUID du propriétaire.',
});

function normalizePartner(partner: PartnerContext['partner']) {
  const plan = String(partner.plan ?? 'white_label_starter');
  const isPro = plan === 'white_label_pro';
  return {
    ...partner,
    plan_label: isPro ? 'White Label Pro' : plan === 'custom' ? 'White Label Sur mesure' : 'White Label Starter',
    included_commerces: Number(partner.included_commerces ?? (isPro ? 25 : 10)),
    monthly_price_cents: Number(partner.monthly_price_cents ?? (isPro ? 44900 : 19900)),
  };
}

async function findUserIdByEmail(db: ReturnType<typeof createServiceClient>, email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    console.warn('[partners] auth user lookup failed:', error.message);
    return null;
  }
  const user = data.users.find((candidate) => candidate.email?.toLowerCase() === normalized);
  return user?.id ?? null;
}

partnerRoutes.use('*', authMiddleware);

partnerRoutes.get('/merchant-branding', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .select('id, white_label_enabled, partners(*)')
    .eq('user_id', userId)
    .eq('actif', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    const missingMigration = error.code === '42703' || error.code === '42P01' || /partner/i.test(error.message ?? '');
    if (missingMigration) return c.json({ data: null });
    return c.json({ error: 'Impossible de charger le branding.' }, 500);
  }

  const partner = Array.isArray(data?.partners) ? data?.partners[0] : data?.partners;
  if (!data?.white_label_enabled || !partner?.white_label_enabled || partner.active === false) {
    return c.json({ data: null });
  }

  return c.json({ data: normalizePartner(partner) });
});

partnerRoutes.use('*', partnerMiddleware);

partnerRoutes.get('/me', async (c) => {
  const context = c.get('partnerContext') as PartnerContext;
  return c.json({ data: normalizePartner(context.partner), role: context.role });
});

partnerRoutes.get('/branding', async (c) => {
  const context = c.get('partnerContext') as PartnerContext;
  return c.json({ data: normalizePartner(context.partner) });
});

partnerRoutes.patch('/branding', async (c) => {
  const context = c.get('partnerContext') as PartnerContext;
  if (context.role === 'viewer') return c.json({ error: 'Droits insuffisants.' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = partnerBrandingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Paramètres branding invalides.', details: parsed.error.flatten() }, 400);
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('partners')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', context.partner_id)
    .select('*')
    .single();

  if (error) return c.json({ error: 'Impossible de mettre à jour le branding.' }, 500);
  return c.json({ data: normalizePartner(data) });
});

partnerRoutes.get('/commerces', async (c) => {
  const context = c.get('partnerContext') as PartnerContext;
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .select('id, nom, email, actif, billing_status, plan, plan_override, white_label_enabled, created_at, cartes(id, nom), clients(id)')
    .eq('partner_id', context.partner_id)
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: 'Impossible de charger les commerces partenaires.' }, 500);
  return c.json({
    data: data ?? [],
    quota: {
      used: data?.length ?? 0,
      included: Number(context.partner.included_commerces ?? 10),
    },
  });
});

partnerRoutes.post('/commerces', async (c) => {
  const context = c.get('partnerContext') as PartnerContext;
  if (context.role === 'viewer') return c.json({ error: 'Droits insuffisants.' }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = partnerCommerceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données commerce invalides.' }, 400);
  }

  const db = createServiceClient();
  const included = Number(context.partner.included_commerces ?? 10);
  const { count, error: countError } = await db
    .from('commerces')
    .select('id', { count: 'exact', head: true })
    .eq('partner_id', context.partner_id);

  if (countError) return c.json({ error: 'Impossible de vérifier le quota partenaire.' }, 500);
  if ((count ?? 0) >= included) {
    return c.json({ error: `Quota atteint: ${included} commerces inclus dans cette offre.` }, 403);
  }

  const ownerUserId = parsed.data.owner_user_id
    ?? (parsed.data.owner_email ? await findUserIdByEmail(db, parsed.data.owner_email) : null);

  if (!ownerUserId) {
    return c.json({
      error: 'Compte propriétaire introuvable. Le commerçant doit d’abord créer son compte, puis vous pourrez rattacher son commerce.',
    }, 404);
  }

  const { data: existingCommerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', ownerUserId)
    .maybeSingle();

  if (existingCommerce) {
    return c.json({ error: 'Cet utilisateur possède déjà un commerce.' }, 409);
  }

  const { data: commerce, error: commerceError } = await db
    .from('commerces')
    .insert({
      user_id: ownerUserId,
      nom: parsed.data.nom,
      email: parsed.data.email ?? parsed.data.owner_email ?? null,
      telephone: parsed.data.telephone ?? null,
      adresse: parsed.data.adresse ?? null,
      plan: 'pro',
      billing_status: 'active',
      onboarding_completed: false,
      partner_id: context.partner_id,
      white_label_enabled: true,
      actif: true,
    })
    .select('id, nom, email, actif, billing_status, plan, white_label_enabled, created_at')
    .single();

  if (commerceError) return c.json({ error: commerceError.message }, 500);

  const pointInsertPayload = {
    commerce_id: commerce.id,
    nom: `${parsed.data.nom} — Principal`,
    adresse: parsed.data.adresse ?? null,
    principal: true,
    actif: true,
  };

  const { error: pointError } = await db
    .from('points_vente')
    .insert(pointInsertPayload);

  if (pointError) {
    console.warn('[partners] point de vente creation failed:', pointError.message);
  }

  return c.json({ data: commerce }, 201);
});
