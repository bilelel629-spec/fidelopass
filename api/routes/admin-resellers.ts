import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../types';
import { createServiceClient } from '../../src/lib/supabase';
import { getStripe } from '../services/stripe-billing';
import {
  createOrInviteResellerUser,
  ensureDefaultResellerPlanSettings,
  ensureDefaultResellerPublicPrices,
  findUserIdByEmail,
  getResellerByUserId,
  normalizeCurrency,
  normalizeHexColor,
  normalizePublicSlug,
  publicResellerUrl,
  normalizeResellerPlan,
  type ResellerPlan,
} from '../services/reseller';
import { sendResellerAccessEmail } from '../services/reseller-email';

export const adminResellerRoutes = new Hono<ApiEnv>();
export const adminResellerPaymentsRoutes = new Hono<ApiEnv>();

const resellerPlanSchema = z.preprocess(
  (value) => normalizeResellerPlan(value),
  z.enum(['starter', 'pro', 'premium']),
);

const resellerCreateSchema = z.object({
  email: z.string().trim().email(),
  type: z.enum(['stripe_connect', 'invoiced']).default('invoiced'),
  status: z.enum(['pending', 'approved', 'suspended']).default('pending'),
  country: z.string().trim().max(80).nullable().optional(),
  currency: z.string().trim().max(3).optional(),
  brand_name: z.string().trim().min(2).max(255).optional(),
  brand_logo_url: z.string().trim().max(1000).nullable().optional(),
  primary_color: z.string().optional(),
  secondary_color: z.string().optional(),
  support_email: z.string().trim().email().nullable().optional(),
  settings: z.array(z.object({
    plan: resellerPlanSchema,
    min_price_cents: z.number().int().min(0),
    platform_fee_cents: z.number().int().min(0),
    currency: z.string().trim().max(3).optional(),
  })).min(1).max(3).optional(),
});

const resellerPatchSchema = resellerCreateSchema.omit({ email: true }).extend({
  public_slug: z.string().trim().max(80).nullable().optional(),
  public_link_enabled: z.boolean().optional(),
  public_signup_enabled: z.boolean().optional(),
}).partial();

const settingsSchema = z.object({
  settings: z.array(z.object({
    plan: resellerPlanSchema,
    min_price_cents: z.number().int().min(0),
    platform_fee_cents: z.number().int().min(0),
    currency: z.string().trim().max(3).optional(),
  })).min(1).max(3),
});

const suspendSchema = z.object({
  suspend_merchants: z.boolean().optional().default(false),
});

const invoiceSchema = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['draft', 'sent']).optional().default('draft'),
});

const invoiceStatusSchema = z.object({
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']),
});

const refundSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

function cents(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function requireUuid(value: string) {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function currentMonthPeriod() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

async function loadReseller(db: ReturnType<typeof createServiceClient>, resellerId: string) {
  const { data: reseller, error } = await db
    .from('resellers')
    .select('*')
    .eq('id', resellerId)
    .maybeSingle();
  if (error) throw error;
  if (!reseller) return null;

  const [settingsRes, publicPricesRes, merchantsRes] = await Promise.all([
    db.from('reseller_plan_settings').select('*').eq('reseller_id', resellerId),
    db.from('reseller_public_plan_prices').select('*').eq('reseller_id', resellerId),
    db.from('reseller_merchants').select('*, commerces(id, nom, email, actif, billing_status)').eq('reseller_id', resellerId),
  ]);

  const settingsError = settingsRes.error as { code?: string; message?: string } | null;
  const settingsMissing = settingsError?.code === '42P01'
    || /reseller_plan_settings/i.test(settingsError?.message ?? '');
  if (settingsError && !settingsMissing) throw settingsError;

  const publicPricesError = publicPricesRes.error as { code?: string; message?: string } | null;
  const publicPricesMissing = publicPricesError?.code === '42P01'
    || /reseller_public_plan_prices/i.test(publicPricesError?.message ?? '');
  if (publicPricesError && !publicPricesMissing) throw publicPricesError;

  const merchantsError = merchantsRes.error as { code?: string; message?: string } | null;
  const merchantsRelationMissing = merchantsError?.code === '42P01'
    || /reseller_merchants|relationship|schema cache/i.test(merchantsError?.message ?? '');
  if (merchantsError && !merchantsRelationMissing) throw merchantsError;

  return {
    ...reseller,
    reseller_plan_settings: settingsMissing ? [] : settingsRes.data ?? [],
    reseller_public_plan_prices: publicPricesMissing ? [] : publicPricesRes.data ?? [],
    reseller_merchants: merchantsRelationMissing ? [] : merchantsRes.data ?? [],
  };
}

function summarizeReseller(row: any) {
  const merchants = row.reseller_merchants ?? [];
  const active = merchants.filter((merchant: any) => ['active', 'trialing'].includes(String(merchant.subscription_status).toLowerCase()));
  const totalRevenue = active.reduce((sum: number, merchant: any) => sum + cents(merchant.reseller_price_cents), 0);
  const platformRevenue = active.reduce((sum: number, merchant: any) => sum + cents(merchant.platform_fee_cents), 0);
  const resellerRevenue = active.reduce((sum: number, merchant: any) => sum + cents(merchant.reseller_margin_cents), 0);
  return {
    ...row,
    public_url: row.public_slug ? publicResellerUrl(row.public_slug) : null,
    metrics: {
      merchants_count: merchants.length,
      active_merchants_count: active.length,
      total_revenue_cents: totalRevenue,
      platform_revenue_cents: platformRevenue,
      reseller_revenue_cents: resellerRevenue,
      currency: row.currency ?? 'eur',
    },
  };
}

async function upsertPlanSettings(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  settings: Array<{ plan: ResellerPlan; min_price_cents: number; platform_fee_cents: number; currency?: string }> | undefined,
  fallbackCurrency: string,
) {
  if (!settings?.length) return null;
  const invalid = settings.find((setting) => setting.platform_fee_cents > setting.min_price_cents);
  if (invalid) return 'La part Fidelopass ne peut pas dépasser le prix minimum.';
  const { error } = await db.from('reseller_plan_settings').upsert(settings.map((setting) => ({
    reseller_id: resellerId,
    plan: setting.plan,
    min_price_cents: setting.min_price_cents,
    platform_fee_cents: setting.platform_fee_cents,
    currency: normalizeCurrency(setting.currency, fallbackCurrency),
    updated_at: new Date().toISOString(),
  })), { onConflict: 'reseller_id,plan' });
  if (error) return 'Impossible de mettre à jour les conditions commerciales du revendeur.';
  return null;
}

async function loadResellerLinkStats(db: ReturnType<typeof createServiceClient>, resellerId: string, currency = 'eur') {
  const [eventsRes, referralsRes] = await Promise.all([
    db.from('reseller_link_events').select('event_type').eq('reseller_id', resellerId),
    db.from('reseller_referrals').select('status, reseller_margin_cents').eq('reseller_id', resellerId),
  ]);
  if (eventsRes.error) console.warn('[admin-resellers] link events load failed', resellerId, eventsRes.error);
  if (referralsRes.error) console.warn('[admin-resellers] referrals load failed', resellerId, referralsRes.error);
  const events = eventsRes.error ? [] : eventsRes.data ?? [];
  const referrals = referralsRes.error ? [] : referralsRes.data ?? [];
  const countEvent = (type: string) => events.filter((event: any) => event.event_type === type).length;
  const paidReferrals = referrals.filter((referral: any) => ['paid', 'active'].includes(String(referral.status)));
  const views = countEvent('view');
  const completed = countEvent('checkout_completed') || paidReferrals.length;
  return {
    views,
    plan_clicks: countEvent('plan_click'),
    signup_started: countEvent('signup_started'),
    checkout_completed: completed,
    conversion_rate: views > 0 ? completed / views : 0,
    generated_clients: paidReferrals.length,
    monthly_reseller_revenue_cents: paidReferrals.reduce((sum: number, referral: any) => sum + cents(referral.reseller_margin_cents), 0),
    currency,
  };
}

adminResellerRoutes.get('/', async (c) => {
  const db = createServiceClient();
  const { data, error } = await db
    .from('resellers')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'Impossible de charger les revendeurs.' }, 500);
  const hydrated = await Promise.all((data ?? []).map(async (row: any) => {
    try {
      return await loadReseller(db, row.id);
    } catch (error) {
      console.warn('[admin-resellers] reseller hydration failed', row.id, error);
      return {
        ...row,
        reseller_plan_settings: [],
        reseller_public_plan_prices: [],
        reseller_merchants: [],
      };
    }
  }));
  return c.json({ data: hydrated.filter(Boolean).map(summarizeReseller) });
});

adminResellerRoutes.get('/users/search', async (c) => {
  const email = c.req.query('email')?.trim().toLowerCase();
  if (!email || !z.string().email().safeParse(email).success) {
    return c.json({ error: 'Email invalide.' }, 400);
  }
  const db = createServiceClient();
  try {
    const userId = await findUserIdByEmail(db, email);
    if (!userId) return c.json({ data: { exists: false, email } });
    const reseller = await getResellerByUserId(db, userId);
    return c.json({
      data: {
        exists: true,
        email,
        user_id: userId,
        reseller_id: reseller?.id ?? null,
        already_reseller: Boolean(reseller?.id),
      },
    });
  } catch (error) {
    return c.json({ error: 'Recherche utilisateur impossible.' }, 500);
  }
});

adminResellerRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = resellerCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Données revendeur invalides.' }, 400);

  const db = createServiceClient();
  const currency = normalizeCurrency(parsed.data.currency, 'eur');
  const brandName = parsed.data.brand_name ?? 'Fidelopass Revendeur';

  let account: Awaited<ReturnType<typeof createOrInviteResellerUser>>;
  try {
    account = await createOrInviteResellerUser(db, parsed.data.email, brandName);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Impossible de préparer le compte revendeur.' }, 500);
  }

  const existing = await getResellerByUserId(db, account.userId);
  if (existing?.id) {
    await db
      .from('resellers')
      .update({
        type: parsed.data.type ?? existing.type,
        status: parsed.data.status ?? existing.status,
        country: parsed.data.country ?? existing.country,
        currency: currency || existing.currency,
        brand_name: brandName || existing.brand_name,
        brand_logo_url: parsed.data.brand_logo_url ?? existing.brand_logo_url ?? null,
        primary_color: normalizeHexColor(parsed.data.primary_color, existing.primary_color ?? '#2563eb'),
        secondary_color: normalizeHexColor(parsed.data.secondary_color, existing.secondary_color ?? '#4f46e5'),
        support_email: parsed.data.support_email ?? existing.support_email ?? parsed.data.email,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    await ensureDefaultResellerPlanSettings(db, existing.id, existing.currency ?? currency);
    const settingsError = await upsertPlanSettings(
      db,
      existing.id,
      parsed.data.settings?.map((setting) => ({ ...setting, plan: setting.plan as ResellerPlan })),
      existing.currency ?? currency,
    );
    if (settingsError) return c.json({ error: settingsError }, 400);
    await ensureDefaultResellerPublicPrices(db, existing.id, existing.currency ?? currency);
    const reseller = await loadReseller(db, existing.id);
    await sendResellerAccessEmail({
      toEmail: parsed.data.email,
      brandName: reseller?.brand_name ?? brandName,
      dashboardUrl: `${(process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '')}/reseller`,
      publicLinkUrl: reseller?.public_slug ? publicResellerUrl(reseller.public_slug) : null,
    });
    return c.json({
      data: summarizeReseller(reseller),
      already_exists: true,
      account_created: account.created,
      invited: account.invited,
      message: 'Ce revendeur existe déjà. Il a été chargé dans la liste.',
    });
  }

  const { data, error } = await db.from('resellers').insert({
    user_id: account.userId,
    type: parsed.data.type,
    status: parsed.data.status,
    country: parsed.data.country ?? null,
    currency,
    brand_name: brandName,
    brand_logo_url: parsed.data.brand_logo_url ?? null,
    primary_color: normalizeHexColor(parsed.data.primary_color, '#2563eb'),
    secondary_color: normalizeHexColor(parsed.data.secondary_color, '#4f46e5'),
    support_email: parsed.data.support_email ?? parsed.data.email,
  }).select('*').single();

  if (error || !data) {
    if (error?.code === '23505') {
      const resellerByUser = await getResellerByUserId(db, account.userId);
      if (resellerByUser?.id) {
        await ensureDefaultResellerPlanSettings(db, resellerByUser.id, resellerByUser.currency ?? currency);
        const settingsError = await upsertPlanSettings(
          db,
          resellerByUser.id,
          parsed.data.settings?.map((setting) => ({ ...setting, plan: setting.plan as ResellerPlan })),
          resellerByUser.currency ?? currency,
        );
        if (settingsError) return c.json({ error: settingsError }, 400);
        await ensureDefaultResellerPublicPrices(db, resellerByUser.id, resellerByUser.currency ?? currency);
        const reseller = await loadReseller(db, resellerByUser.id);
        await sendResellerAccessEmail({
          toEmail: parsed.data.email,
          brandName: reseller?.brand_name ?? brandName,
          dashboardUrl: `${(process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '')}/reseller`,
          publicLinkUrl: reseller?.public_slug ? publicResellerUrl(reseller.public_slug) : null,
        });
        return c.json({
          data: summarizeReseller(reseller),
          already_exists: true,
          account_created: account.created,
          invited: account.invited,
          message: 'Ce revendeur existe déjà. Il a été chargé dans la liste.',
        });
      }
    }
    return c.json({ error: error?.message ?? 'Impossible de créer le revendeur.' }, 400);
  }

  await ensureDefaultResellerPlanSettings(db, data.id, currency);
  const settingsError = await upsertPlanSettings(
    db,
    data.id,
    parsed.data.settings?.map((setting) => ({ ...setting, plan: setting.plan as ResellerPlan })),
    currency,
  );
  if (settingsError) return c.json({ error: settingsError }, 400);
  await ensureDefaultResellerPublicPrices(db, data.id, currency);
  const reseller = await loadReseller(db, data.id);
  await sendResellerAccessEmail({
    toEmail: parsed.data.email,
    brandName,
    dashboardUrl: `${(process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '')}/reseller`,
    publicLinkUrl: data.public_slug ? publicResellerUrl(data.public_slug) : null,
  });
  return c.json({
    data: summarizeReseller(reseller),
    account_created: account.created,
    invited: account.invited,
    message: account.invited
      ? 'Revendeur créé. Une invitation de connexion a été envoyée.'
      : 'Revendeur créé.',
  }, 201);
});

adminResellerRoutes.get('/:id', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const db = createServiceClient();
  let reseller: Awaited<ReturnType<typeof loadReseller>>;
  try {
    reseller = await loadReseller(db, resellerId);
  } catch (error) {
    console.warn('[admin-resellers] reseller detail load failed', resellerId, error);
    return c.json({ error: 'Impossible de charger le dossier revendeur. Vérifiez que les migrations revendeur sont appliquées.' }, 500);
  }
  if (!reseller) return c.json({ error: 'Revendeur introuvable.' }, 404);

  const [transactionsRes, invoicesRes] = await Promise.all([
    db.from('reseller_transactions').select('*').eq('reseller_id', resellerId).order('created_at', { ascending: false }).limit(80),
    db.from('reseller_invoices').select('*, reseller_invoice_lines(*)').eq('reseller_id', resellerId).order('period_start', { ascending: false }),
  ]);
  if (transactionsRes.error) console.warn('[admin-resellers] transactions load failed', resellerId, transactionsRes.error);
  if (invoicesRes.error) console.warn('[admin-resellers] invoices load failed', resellerId, invoicesRes.error);

  return c.json({
    data: summarizeReseller(reseller),
    transactions: transactionsRes.error ? [] : transactionsRes.data ?? [],
    invoices: invoicesRes.error ? [] : invoicesRes.data ?? [],
    link_stats: await loadResellerLinkStats(db, resellerId, reseller.currency ?? 'eur'),
  });
});

adminResellerRoutes.patch('/:id', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = resellerPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Données revendeur invalides.' }, 400);

  const db = createServiceClient();
  const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  delete updates.public_slug;
  if (parsed.data.currency) updates.currency = normalizeCurrency(parsed.data.currency, 'eur');
  if (parsed.data.primary_color) updates.primary_color = normalizeHexColor(parsed.data.primary_color, '#2563eb');
  if (parsed.data.secondary_color) updates.secondary_color = normalizeHexColor(parsed.data.secondary_color, '#4f46e5');
  if (Object.prototype.hasOwnProperty.call(parsed.data, 'public_slug')) {
    const rawSlug = parsed.data.public_slug;
    if (rawSlug === null || rawSlug === '') {
      updates.public_slug = null;
    } else {
      const slug = normalizePublicSlug(rawSlug);
      if (!slug) return c.json({ error: 'Slug public invalide ou réservé.' }, 400);
      const { data: existing, error: existingError } = await db
        .from('resellers')
        .select('id')
        .eq('public_slug', slug)
        .neq('id', resellerId)
        .maybeSingle();
      if (existingError) return c.json({ error: 'Impossible de vérifier ce slug.' }, 500);
      if (existing?.id) return c.json({ error: 'Ce slug public est déjà utilisé.' }, 409);
      updates.public_slug = slug;
    }
  }

  const { error } = await db.from('resellers').update(updates).eq('id', resellerId);
  if (error) return c.json({ error: 'Impossible de modifier le revendeur.' }, 500);
  const reseller = await loadReseller(db, resellerId);
  return c.json({ data: summarizeReseller(reseller) });
});

adminResellerRoutes.post('/:id/approve', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const db = createServiceClient();
  const { error } = await db.from('resellers').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', resellerId);
  if (error) return c.json({ error: 'Impossible d’approuver le revendeur.' }, 500);
  return c.json({ ok: true });
});

adminResellerRoutes.post('/:id/suspend', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const parsed = suspendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Paramètres invalides.' }, 400);
  const db = createServiceClient();
  const now = new Date().toISOString();
  await db.from('resellers').update({ status: 'suspended', updated_at: now }).eq('id', resellerId);
  if (parsed.data.suspend_merchants) {
    const { data: merchants } = await db.from('reseller_merchants').select('merchant_id').eq('reseller_id', resellerId);
    await db.from('reseller_merchants').update({ subscription_status: 'suspended', updated_at: now }).eq('reseller_id', resellerId);
    const merchantIds = (merchants ?? []).map((merchant: any) => merchant.merchant_id).filter(Boolean);
    if (merchantIds.length) {
      await db.from('commerces').update({ actif: false, billing_status: 'past_due', updated_at: now }).in('id', merchantIds);
    }
  }
  return c.json({ ok: true });
});

adminResellerRoutes.post('/:id/reactivate', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const db = createServiceClient();
  const { error } = await db.from('resellers').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', resellerId);
  if (error) return c.json({ error: 'Impossible de réactiver le revendeur.' }, 500);
  return c.json({ ok: true });
});

adminResellerRoutes.post('/:id/settings', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Paramètres de plans invalides.' }, 400);

  const invalidSetting = parsed.data.settings.find((setting) => setting.platform_fee_cents > setting.min_price_cents);
  if (invalidSetting) {
    return c.json({ error: 'La part Fidelopass ne peut pas dépasser le prix minimum.' }, 400);
  }

  const rows = parsed.data.settings.map((setting) => ({
      reseller_id: resellerId,
      plan: setting.plan as ResellerPlan,
      min_price_cents: setting.min_price_cents,
      platform_fee_cents: setting.platform_fee_cents,
      currency: normalizeCurrency(setting.currency, 'eur'),
      updated_at: new Date().toISOString(),
  }));

  const db = createServiceClient();
  const { data, error } = await db
    .from('reseller_plan_settings')
    .upsert(rows, { onConflict: 'reseller_id,plan' })
    .select('*');
  if (error) return c.json({ error: 'Impossible de modifier les paramètres.' }, 500);
  return c.json({ data });
});

adminResellerRoutes.post('/:id/generate-invoice', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  if (!resellerId) return c.json({ error: 'Identifiant revendeur invalide.' }, 400);
  const parsed = invoiceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Paramètres de facture invalides.' }, 400);

  const db = createServiceClient();
  const { data: reseller } = await db.from('resellers').select('*').eq('id', resellerId).maybeSingle();
  if (!reseller) return c.json({ error: 'Revendeur introuvable.' }, 404);
  if (reseller.type !== 'invoiced') return c.json({ error: 'La facturation mensuelle est réservée aux revendeurs facturés.' }, 400);

  const period = {
    ...currentMonthPeriod(),
    ...Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => typeof value === 'string')),
  } as { period_start: string; period_end: string; status?: string };

  const { data: merchants, error: merchantsError } = await db
    .from('reseller_merchants')
    .select('*')
    .eq('reseller_id', resellerId)
    .in('subscription_status', ['active', 'trialing']);
  if (merchantsError) return c.json({ error: 'Impossible de charger les commerçants actifs.' }, 500);

  const activeMerchants = merchants ?? [];
  const total = activeMerchants.reduce((sum: number, merchant: any) => sum + cents(merchant.platform_fee_cents), 0);
  const { data: invoice, error: invoiceError } = await db.from('reseller_invoices').insert({
    reseller_id: resellerId,
    period_start: period.period_start,
    period_end: period.period_end,
    total_merchants: activeMerchants.length,
    total_platform_fee_cents: total,
    currency: reseller.currency ?? 'eur',
    status: parsed.data.status,
  }).select('*').single();
  if (invoiceError || !invoice) return c.json({ error: 'Impossible de générer la facture.' }, 500);

  const lines = activeMerchants.map((merchant: any) => ({
    invoice_id: invoice.id,
    reseller_merchant_id: merchant.id,
    merchant_id: merchant.merchant_id,
    plan: merchant.plan,
    platform_fee_cents: cents(merchant.platform_fee_cents),
    period_start: period.period_start,
    period_end: period.period_end,
  }));
  if (lines.length) {
    await db.from('reseller_invoice_lines').insert(lines);
  }
  await db.from('reseller_transactions').insert({
    reseller_id: resellerId,
    type: 'manual_invoice',
    amount_cents: total,
    platform_fee_cents: total,
    reseller_amount_cents: 0,
    currency: reseller.currency ?? 'eur',
    metadata: { invoice_id: invoice.id, period_start: period.period_start, period_end: period.period_end },
  });

  return c.json({ data: invoice, lines });
});

adminResellerRoutes.post('/:id/invoices/:invoiceId/status', async (c) => {
  const resellerId = requireUuid(c.req.param('id'));
  const invoiceId = requireUuid(c.req.param('invoiceId'));
  if (!resellerId || !invoiceId) return c.json({ error: 'Identifiant facture invalide.' }, 400);

  const parsed = invoiceStatusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Statut de facture invalide.' }, 400);

  const db = createServiceClient();
  const { data, error } = await db
    .from('reseller_invoices')
    .update({
      status: parsed.data.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('reseller_id', resellerId)
    .select('*')
    .maybeSingle();

  if (error) return c.json({ error: 'Impossible de modifier la facture.' }, 500);
  if (!data) return c.json({ error: 'Facture introuvable.' }, 404);

  return c.json({ data });
});

adminResellerPaymentsRoutes.post('/:id/refund', async (c) => {
  const transactionId = requireUuid(c.req.param('id'));
  if (!transactionId) return c.json({ error: 'Identifiant transaction invalide.' }, 400);
  const parsed = refundSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Paramètres de remboursement invalides.' }, 400);

  const db = createServiceClient();
  const { data: tx, error } = await db.from('reseller_transactions').select('*').eq('id', transactionId).maybeSingle();
  if (error || !tx) return c.json({ error: 'Transaction introuvable.' }, 404);
  if (tx.type !== 'subscription_paid') return c.json({ error: 'Seules les transactions payées peuvent être remboursées.' }, 400);
  if (!tx.stripe_payment_intent_id && !tx.stripe_charge_id) {
    return c.json({ error: 'Transaction Stripe non remboursable.' }, 400);
  }

  const stripe = getStripe();
  const refund = await stripe.refunds.create({
    ...(tx.stripe_payment_intent_id ? { payment_intent: tx.stripe_payment_intent_id } : { charge: tx.stripe_charge_id }),
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: {
      reseller_transaction_id: tx.id,
      reason: parsed.data.reason ?? 'admin_refund',
    },
  } as any);

  await db.from('reseller_transactions').insert({
    reseller_id: tx.reseller_id,
    merchant_id: tx.merchant_id,
    reseller_merchant_id: tx.reseller_merchant_id,
    type: 'refund',
    amount_cents: -Math.abs(cents(tx.amount_cents)),
    platform_fee_cents: -Math.abs(cents(tx.platform_fee_cents)),
    reseller_amount_cents: -Math.abs(cents(tx.reseller_amount_cents)),
    currency: tx.currency,
    stripe_payment_intent_id: tx.stripe_payment_intent_id,
    stripe_charge_id: tx.stripe_charge_id,
    metadata: { refund_id: refund.id, original_transaction_id: tx.id },
  });

  return c.json({ data: refund });
});
