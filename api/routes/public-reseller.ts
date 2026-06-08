import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../types';
import { createServiceClient } from '../../src/lib/supabase';
import { getStripe } from '../services/stripe-billing';
import {
  createOrInviteMerchantUser,
  createResellerStripePrice,
  ensureDefaultResellerPublicPrices,
  ensureMerchantCommerce,
  getResellerPlanSetting,
  getResellerPlanSettings,
  normalizeCurrency,
  normalizePublicSlug,
  normalizeResellerPlan,
  publicResellerUrl,
  resellerPlanLabel,
  type ResellerPlan,
  type ResellerRecord,
} from '../services/reseller';

export const publicResellerRoutes = new Hono<ApiEnv>();

// GET /api/public/reseller/session-status?session_id=XXX
publicResellerRoutes.get('/session-status', async (c) => {
  const sessionId = c.req.query('session_id');
  if (!sessionId || sessionId.length < 10) return c.json({ error: 'session_id requis.' }, 400);
  const db = createServiceClient();
  const { data: merchant } = await db
    .from('reseller_merchants')
    .select('merchant_email, plan, reseller_id, merchant_id')
    .eq('stripe_checkout_session_id', sessionId)
    .single();
  if (!merchant) return c.json({ error: 'Session introuvable.' }, 404);
  const { data: reseller } = await db
    .from('resellers')
    .select('public_slug, brand_name')
    .eq('id', merchant.reseller_id)
    .single();
  return c.json({
    data: {
      merchant_email: merchant.merchant_email,
      plan: merchant.plan,
      reseller_slug: reseller?.public_slug ?? null,
      ready: !!merchant.merchant_id,
    },
  });
});

const setupAccountSchema = z.object({
  session_id: z.string().min(10),
  password: z.string().min(8).max(128),
});

// POST /api/public/reseller/setup-account
publicResellerRoutes.post('/setup-account', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = setupAccountSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Données invalides. Le mot de passe doit faire au moins 8 caractères.' }, 400);
  const db = createServiceClient();
  const { data: merchant } = await db
    .from('reseller_merchants')
    .select('merchant_id, merchant_email, subscription_status')
    .eq('stripe_checkout_session_id', parsed.data.session_id)
    .single();
  if (!merchant) return c.json({ error: 'Session introuvable.' }, 404);
  if (!merchant.merchant_id) return c.json({ error: 'Compte en cours d\'activation, réessayez dans quelques secondes.' }, 409);
  const { data: commerce } = await db
    .from('commerces')
    .select('user_id')
    .eq('id', merchant.merchant_id)
    .single();
  if (!commerce?.user_id) return c.json({ error: 'Compte introuvable.' }, 404);
  const { error } = await db.auth.admin.updateUserById(commerce.user_id, {
    password: parsed.data.password,
    email_confirm: true,
  });
  if (error) return c.json({ error: 'Impossible de définir le mot de passe.' }, 500);
  return c.json({ ok: true, email: merchant.merchant_email });
});

const planSchema = z.preprocess(
  (value) => normalizeResellerPlan(value),
  z.enum(['starter', 'pro', 'premium']),
);

const publicSignupSchema = z.object({
  commerce_name: z.string().trim().min(2).max(255),
  email: z.string().trim().email(),
  phone: z.string().trim().max(50).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  plan: planSchema,
});

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
}

function unavailableMessage() {
  return 'Cette offre revendeur n’est plus disponible.';
}

async function loadPublicReseller(db: ReturnType<typeof createServiceClient>, rawSlug: string) {
  const slug = normalizePublicSlug(rawSlug);
  if (!slug) return null;
  const { data, error } = await db
    .from('resellers')
    .select('*')
    .eq('public_slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data as ResellerRecord | null;
}

async function loadEnabledPublicPrices(db: ReturnType<typeof createServiceClient>, resellerId: string) {
  const { data, error } = await db
    .from('reseller_public_plan_prices')
    .select('*')
    .eq('reseller_id', resellerId)
    .eq('is_enabled', true)
    .order('public_price_cents');
  if (error) {
    const missing = error.code === '42P01' || /reseller_public_plan_prices/i.test(error.message ?? '');
    if (missing) return [];
    throw error;
  }
  return data ?? [];
}

async function logLinkEvent(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  eventType: 'view' | 'plan_click' | 'signup_started' | 'checkout_started' | 'checkout_completed',
  plan?: ResellerPlan | null,
  metadata: Record<string, unknown> = {},
) {
  await db.from('reseller_link_events').insert({
    reseller_id: resellerId,
    event_type: eventType,
    plan: plan ?? null,
    metadata,
  }).then(({ error }) => {
    if (error) console.warn('[public-reseller] link event failed:', error.message);
  });
}

async function loadPublicPlanOrThrow(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  plan: ResellerPlan,
) {
  const { data, error } = await db
    .from('reseller_public_plan_prices')
    .select('*')
    .eq('reseller_id', resellerId)
    .eq('plan', plan)
    .eq('is_enabled', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Cette offre n’est pas active.');

  const setting = await getResellerPlanSetting(db, resellerId, plan);
  const publicPrice = Number(data.public_price_cents);
  const platformFee = Number(data.platform_fee_cents);
  if (publicPrice < Number(setting.min_price_cents) || platformFee < Number(setting.platform_fee_cents) || platformFee > publicPrice) {
    throw new Error('Cette offre doit être vérifiée par le revendeur avant inscription.');
  }
  return data;
}

async function publicResellerPayload(
  db: ReturnType<typeof createServiceClient>,
  reseller: ResellerRecord,
  prices: any[],
) {
  const settings = await getResellerPlanSettings(db, reseller.id);
  const checkoutAvailable = true;
  const checkoutMessage = null;

  return {
    brand_name: reseller.brand_name,
    brand_logo_url: reseller.brand_logo_url,
    primary_color: reseller.primary_color,
    secondary_color: reseller.secondary_color,
    support_email: reseller.support_email,
    public_slug: reseller.public_slug,
    public_url: reseller.public_slug ? publicResellerUrl(reseller.public_slug) : null,
    type: reseller.type,
    signup_enabled: reseller.public_signup_enabled !== false,
    checkout_available: checkoutAvailable,
    checkout_message: checkoutMessage,
    plans: prices.map((price) => ({
      ...(() => {
        const setting = settings.get(price.plan);
        const publicPrice = Number(price.public_price_cents);
        const platformFee = Number(price.platform_fee_cents);
        const minPrice = Number(setting?.min_price_cents ?? 0);
        const minFee = Number(setting?.platform_fee_cents ?? 0);
        let validationMessage: string | null = null;
        if (!setting) {
          validationMessage = 'Paramètres du plan introuvables.';
        } else if (publicPrice < minPrice) {
          validationMessage = `Prix trop bas. Minimum: ${Math.round(minPrice / 100)}€.`;
        } else if (platformFee < minFee || platformFee > publicPrice) {
          validationMessage = 'La part Fidelopass doit être vérifiée par le revendeur.';
        }
        return {
          is_valid: !validationMessage,
          validation_message: validationMessage,
        };
      })(),
      plan: price.plan,
      label: resellerPlanLabel(price.plan),
      public_price_cents: price.public_price_cents,
      currency: price.currency,
    })),
  };
}

publicResellerRoutes.get('/:slug', async (c) => {
  const db = createServiceClient();
  try {
    const reseller = await loadPublicReseller(db, c.req.param('slug'));
    if (!reseller || reseller.status !== 'approved' || !reseller.public_link_enabled) {
      return c.json({ available: false, message: unavailableMessage() }, 404);
    }
    let prices = await loadEnabledPublicPrices(db, reseller.id);
    if (!prices.length) {
      await ensureDefaultResellerPublicPrices(db, reseller.id, reseller.currency);
      prices = await loadEnabledPublicPrices(db, reseller.id);
    }
    if (!prices.length) {
      return c.json({ available: false, message: 'Cette offre doit encore être configurée par le revendeur.' }, 404);
    }
    await logLinkEvent(db, reseller.id, 'view', null, {
      user_agent: c.req.header('user-agent') ?? null,
    });
    return c.json({ available: true, data: await publicResellerPayload(db, reseller, prices) });
  } catch (error) {
    return c.json({ available: false, message: unavailableMessage() }, 500);
  }
});

publicResellerRoutes.post('/:slug/track', async (c) => {
  const body = await c.req.json().catch(() => null);
  const plan = normalizeResellerPlan(body?.plan);
  const eventType = String(body?.event_type ?? '');
  if (!['plan_click'].includes(eventType) || !plan) return c.json({ ok: false }, 400);

  const db = createServiceClient();
  const reseller = await loadPublicReseller(db, c.req.param('slug'));
  if (!reseller || reseller.status !== 'approved' || !reseller.public_link_enabled) return c.json({ ok: false }, 404);
  await logLinkEvent(db, reseller.id, 'plan_click', plan);
  return c.json({ ok: true });
});

publicResellerRoutes.post('/:slug/start-signup', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = publicSignupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Informations invalides.' }, 400);

  const db = createServiceClient();
  try {
    const reseller = await loadPublicReseller(db, c.req.param('slug'));
    if (!reseller || reseller.status !== 'approved' || !reseller.public_link_enabled || reseller.public_signup_enabled === false) {
      return c.json({ error: unavailableMessage() }, 403);
    }
    const publicPrice = await loadPublicPlanOrThrow(db, reseller.id, parsed.data.plan);
    const { data, error } = await db.from('reseller_referrals').insert({
      reseller_id: reseller.id,
      merchant_name: parsed.data.commerce_name,
      merchant_email: parsed.data.email,
      plan: parsed.data.plan,
      public_price_cents: publicPrice.public_price_cents,
      platform_fee_cents: publicPrice.platform_fee_cents,
      reseller_margin_cents: publicPrice.reseller_margin_cents,
      currency: normalizeCurrency(publicPrice.currency, reseller.currency),
      status: 'pending',
      source: 'public_link',
    }).select('*').single();
    if (error) throw error;
    await logLinkEvent(db, reseller.id, 'signup_started', parsed.data.plan);
    return c.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de démarrer cette inscription.';
    return c.json({ error: message }, 400);
  }
});

publicResellerRoutes.post('/:slug/checkout', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = publicSignupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Informations invalides.' }, 400);

  const db = createServiceClient();
  try {
    const reseller = await loadPublicReseller(db, c.req.param('slug'));
    if (!reseller || reseller.status !== 'approved' || !reseller.public_link_enabled || reseller.public_signup_enabled === false) {
      return c.json({ error: unavailableMessage() }, 403);
    }
    const publicPrice = await loadPublicPlanOrThrow(db, reseller.id, parsed.data.plan);
    const currency = normalizeCurrency(publicPrice.currency, reseller.currency);
    const { data: referral, error: referralError } = await db.from('reseller_referrals').insert({
      reseller_id: reseller.id,
      merchant_name: parsed.data.commerce_name,
      merchant_email: parsed.data.email,
      plan: parsed.data.plan,
      public_price_cents: publicPrice.public_price_cents,
      platform_fee_cents: publicPrice.platform_fee_cents,
      reseller_margin_cents: publicPrice.reseller_margin_cents,
      currency,
      status: 'checkout_started',
      source: 'public_link',
    }).select('*').single();
    if (referralError || !referral) throw new Error(referralError?.message ?? 'Inscription impossible.');

    const { data: resellerMerchant, error: merchantError } = await db
      .from('reseller_merchants')
      .insert({
        reseller_id: reseller.id,
        merchant_name: parsed.data.commerce_name,
        merchant_email: parsed.data.email,
        merchant_phone: parsed.data.phone ?? null,
        country: parsed.data.country ?? reseller.country ?? null,
        plan: parsed.data.plan,
        reseller_price_cents: publicPrice.public_price_cents,
        platform_fee_cents: publicPrice.platform_fee_cents,
        reseller_margin_cents: publicPrice.reseller_margin_cents,
        currency,
        payment_mode: 'stripe_direct',
        subscription_status: 'incomplete',
        source: 'public_link',
      })
      .select('*')
      .single();
    if (merchantError || !resellerMerchant) throw new Error(merchantError?.message ?? 'Rattachement impossible.');

    // Nouveau parcours : l'utilisateur est authentifié avant le checkout.
    // Ancien parcours (compat) : on envoie une invitation email.
    const authHeader = c.req.header('Authorization');
    let preAuthUserId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const { data: { user } } = await db.auth.getUser(token);
      preAuthUserId = user?.id ?? null;
    }

    const account = preAuthUserId
      ? { userId: preAuthUserId, created: false, invited: false }
      : await createOrInviteMerchantUser(db, parsed.data.email, parsed.data.commerce_name, 'invite');
    const commerceId = await ensureMerchantCommerce(db, {
      ownerUserId: account.userId,
      commerceName: parsed.data.commerce_name,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      country: parsed.data.country ?? reseller.country ?? null,
      resellerId: reseller.id,
      resellerMerchantId: resellerMerchant.id,
      plan: parsed.data.plan,
      billingStatus: 'unpaid',
      paymentMode: 'stripe_direct',
      resellerPriceCents: publicPrice.public_price_cents,
      platformFeeCents: publicPrice.platform_fee_cents,
    });

    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email: parsed.data.email,
      name: parsed.data.commerce_name,
      metadata: {
        reseller_id: reseller.id,
        reseller_merchant_id: resellerMerchant.id,
        merchant_id: commerceId,
        referral_id: referral.id,
        source: 'public_link',
      },
    });
    const price = await createResellerStripePrice(stripe, {
      plan: parsed.data.plan,
      amountCents: publicPrice.public_price_cents,
      currency,
      resellerId: reseller.id,
      merchantId: commerceId,
    });
    const metadata = {
      kind: 'reseller_merchant_subscription',
      reseller_id: reseller.id,
      reseller_merchant_id: resellerMerchant.id,
      merchant_id: commerceId,
      referral_id: referral.id,
      plan: parsed.data.plan,
      source: 'public_link',
      payment_mode: 'stripe_direct',
      reseller_price_cents: String(publicPrice.public_price_cents),
      platform_fee_cents: String(publicPrice.platform_fee_cents),
      reseller_margin_cents: String(publicPrice.reseller_margin_cents),
      currency,
    };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${siteUrl()}/r/success?session_id={CHECKOUT_SESSION_ID}&slug=${reseller.public_slug}`,
      cancel_url: `${siteUrl()}/r/${reseller.public_slug}?cancelled=1`,
      locale: 'fr',
      metadata,
      subscription_data: {
        trial_period_days: 14,
        metadata,
      },
    });

    await Promise.all([
      db.from('reseller_merchants').update({
        merchant_id: commerceId,
        stripe_customer_id: customer.id,
        stripe_checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      }).eq('id', resellerMerchant.id),
      db.from('reseller_referrals').update({
        reseller_merchant_id: resellerMerchant.id,
        merchant_id: commerceId,
        checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      }).eq('id', referral.id),
      logLinkEvent(db, reseller.id, 'checkout_started', parsed.data.plan, { referral_id: referral.id }),
    ]);

    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de créer le paiement.';
    return c.json({ error: message }, 400);
  }
});

publicResellerRoutes.post('/:slug/manual-request', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = publicSignupSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Informations invalides.' }, 400);

  const db = createServiceClient();
  try {
    const reseller = await loadPublicReseller(db, c.req.param('slug'));
    if (!reseller || reseller.status !== 'approved' || !reseller.public_link_enabled || reseller.public_signup_enabled === false) {
      return c.json({ error: unavailableMessage() }, 403);
    }
    if (reseller.type !== 'invoiced') {
      return c.json({ error: 'Ce revendeur utilise le paiement en ligne.' }, 400);
    }
    const publicPrice = await loadPublicPlanOrThrow(db, reseller.id, parsed.data.plan);
    const currency = normalizeCurrency(publicPrice.currency, reseller.currency);
    const { data: resellerMerchant, error: merchantError } = await db
      .from('reseller_merchants')
      .insert({
        reseller_id: reseller.id,
        merchant_name: parsed.data.commerce_name,
        merchant_email: parsed.data.email,
        merchant_phone: parsed.data.phone ?? null,
        country: parsed.data.country ?? reseller.country ?? null,
        plan: parsed.data.plan,
        reseller_price_cents: publicPrice.public_price_cents,
        platform_fee_cents: publicPrice.platform_fee_cents,
        reseller_margin_cents: publicPrice.reseller_margin_cents,
        currency,
        payment_mode: 'manual',
        subscription_status: 'pending',
        source: 'public_link',
      })
      .select('*')
      .single();
    if (merchantError || !resellerMerchant) throw new Error(merchantError?.message ?? 'Demande impossible.');

    const { data: referral, error: referralError } = await db.from('reseller_referrals').insert({
      reseller_id: reseller.id,
      reseller_merchant_id: resellerMerchant.id,
      merchant_name: parsed.data.commerce_name,
      merchant_email: parsed.data.email,
      plan: parsed.data.plan,
      public_price_cents: publicPrice.public_price_cents,
      platform_fee_cents: publicPrice.platform_fee_cents,
      reseller_margin_cents: publicPrice.reseller_margin_cents,
      currency,
      status: 'pending',
      source: 'public_link',
    }).select('*').single();
    if (referralError) throw new Error(referralError.message);
    await logLinkEvent(db, reseller.id, 'signup_started', parsed.data.plan, { referral_id: referral?.id ?? null });
    return c.json({ ok: true, data: referral });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible d’envoyer la demande.';
    return c.json({ error: message }, 400);
  }
});
