import { Hono } from 'hono';
import { z } from 'zod';
import Stripe from 'stripe';
import type { Context } from 'hono';
import type { ApiEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { resellerMiddleware, type ResellerContext } from '../middleware/reseller';
import { createServiceClient } from '../../src/lib/supabase';
import { getStripe } from '../services/stripe-billing';
import {
  calculateResellerPricing,
  createOrInviteMerchantUser,
  createResellerStripePrice,
  ensureMerchantCommerce,
  getResellerByUserId,
  getResellerPlanSetting,
  getResellerPlanSettings,
  normalizeCurrency,
  normalizeHexColor,
  normalizeResellerPlan,
  normalizeStripeCountryCode,
  resellerPlanToCommercePlan,
  stripeApplicationFeePercent,
} from '../services/reseller';

export const resellerRoutes = new Hono<ApiEnv>();

const resellerPlanSchema = z.preprocess(
  (value) => normalizeResellerPlan(value),
  z.enum(['starter', 'pro', 'premium']),
);

const merchantCreateSchema = z.object({
  commerce_name: z.string().trim().min(2).max(255),
  email: z.string().trim().email(),
  phone: z.string().trim().max(50).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  plan: resellerPlanSchema,
  price_cents: z.number().int().min(0),
  payment_mode: z.enum(['stripe_connect', 'manual', 'bank_transfer', 'cash']),
  creation_mode: z.enum(['direct', 'invite']).default('invite'),
  activate_now: z.boolean().optional().default(false),
});

const merchantChangePlanSchema = z.object({
  plan: resellerPlanSchema,
  price_cents: z.number().int().min(0),
});

const brandingSchema = z.object({
  brand_name: z.string().trim().min(2).max(255).optional(),
  brand_logo_url: z.string().trim().max(1000).nullable().optional(),
  primary_color: z.string().optional(),
  secondary_color: z.string().optional(),
  support_email: z.string().trim().email().nullable().optional(),
});

const cancelSchema = z.object({
  suspend: z.boolean().optional().default(false),
});

function getResellerContext(c: Context): ResellerContext {
  return c.get('resellerContext') as ResellerContext;
}

function siteUrl() {
  return (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
}

function normalizeMerchant(row: any) {
  return {
    ...row,
    commerce: Array.isArray(row.commerces) ? row.commerces[0] : row.commerces,
  };
}

async function loadOwnedResellerMerchant(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  resellerMerchantId: string,
) {
  const { data, error } = await db
    .from('reseller_merchants')
    .select('*, commerces(id, nom, email, actif, billing_status, stripe_customer_id, stripe_subscription_id)')
    .eq('id', resellerMerchantId)
    .eq('reseller_id', resellerId)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeMerchant(data) : null;
}

function hasActiveSubscription(merchant: any) {
  const status = String(merchant?.subscription_status ?? '').toLowerCase();
  return Boolean(merchant?.stripe_subscription_id)
    || ['active', 'trialing', 'incomplete', 'past_due'].includes(status);
}

async function syncStripeAccountStatus(
  stripe: Stripe,
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  accountId: string,
) {
  const account = await stripe.accounts.retrieve(accountId);
  const requirements = account.requirements?.currently_due ?? [];
  const updates = {
    stripe_onboarding_completed: requirements.length === 0 && Boolean(account.details_submitted),
    stripe_charges_enabled: Boolean(account.charges_enabled),
    stripe_payouts_enabled: Boolean(account.payouts_enabled),
    updated_at: new Date().toISOString(),
  };
  await db.from('resellers').update(updates).eq('id', resellerId);
  return { account, updates };
}

resellerRoutes.use('*', authMiddleware);

resellerRoutes.get('/me', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  try {
    const reseller = await getResellerByUserId(db, userId);
    if (!reseller) return c.json({ data: null, status: 'missing' });
    const settings = await getResellerPlanSettings(db, reseller.id);
    return c.json({ data: reseller, settings: Array.from(settings.values()) });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    const missingMigration = err.code === '42P01' || /resellers/i.test(err.message ?? '');
    if (missingMigration) return c.json({ data: null, status: 'not_ready' });
    return c.json({ error: 'Impossible de charger votre dossier revendeur.' }, 500);
  }
});

resellerRoutes.use('*', resellerMiddleware);

resellerRoutes.get('/dashboard', async (c) => {
  const { reseller } = getResellerContext(c);
  const db = createServiceClient();
  const [merchantsRes, transactionsRes, invoicesRes] = await Promise.all([
    db.from('reseller_merchants').select('*').eq('reseller_id', reseller.id).order('created_at', { ascending: false }),
    db.from('reseller_transactions').select('*').eq('reseller_id', reseller.id).order('created_at', { ascending: false }).limit(20),
    db.from('reseller_invoices').select('*').eq('reseller_id', reseller.id).order('period_start', { ascending: false }).limit(12),
  ]);
  if (merchantsRes.error) return c.json({ error: 'Impossible de charger les commerçants.' }, 500);

  const merchants = merchantsRes.data ?? [];
  const active = merchants.filter((merchant: any) => ['active', 'trialing'].includes(String(merchant.subscription_status).toLowerCase()));
  const suspended = merchants.filter((merchant: any) => ['suspended', 'past_due', 'cancelled', 'canceled'].includes(String(merchant.subscription_status).toLowerCase()));
  const monthlyResellerRevenue = active.reduce((sum: number, merchant: any) => sum + Number(merchant.reseller_margin_cents ?? 0), 0);
  const monthlyPlatformFee = active.reduce((sum: number, merchant: any) => sum + Number(merchant.platform_fee_cents ?? 0), 0);

  return c.json({
    reseller,
    metrics: {
      active_clients: active.length,
      suspended_clients: suspended.length,
      monthly_reseller_revenue_cents: monthlyResellerRevenue,
      annual_reseller_revenue_cents: monthlyResellerRevenue * 12,
      monthly_platform_fee_cents: monthlyPlatformFee,
      annual_platform_fee_cents: monthlyPlatformFee * 12,
      currency: reseller.currency,
    },
    merchants: merchants.slice(0, 8),
    transactions: transactionsRes.data ?? [],
    invoices: invoicesRes.data ?? [],
  });
});

resellerRoutes.get('/branding', async (c) => {
  const { reseller } = getResellerContext(c);
  return c.json({ data: reseller });
});

resellerRoutes.patch('/branding', async (c) => {
  const { reseller } = getResellerContext(c);
  const body = await c.req.json().catch(() => null);
  const parsed = brandingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Paramètres de marque invalides.' }, 400);

  const db = createServiceClient();
  const updates = {
    ...parsed.data,
    primary_color: normalizeHexColor(parsed.data.primary_color, reseller.primary_color),
    secondary_color: normalizeHexColor(parsed.data.secondary_color, reseller.secondary_color),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db.from('resellers').update(updates).eq('id', reseller.id).select('*').single();
  if (error) return c.json({ error: 'Impossible de mettre à jour la marque.' }, 500);
  return c.json({ data });
});

resellerRoutes.get('/stripe/status', async (c) => {
  const { reseller } = getResellerContext(c);
  if (reseller.type !== 'stripe_connect') {
    return c.json({ data: { enabled: false, message: 'Ce revendeur est en mode facturé.' } });
  }
  if (!reseller.stripe_connect_account_id) {
    return c.json({ data: { enabled: false, connected: false, reseller } });
  }

  const db = createServiceClient();
  const stripe = getStripe();
  try {
    const { updates } = await syncStripeAccountStatus(stripe, db, reseller.id, reseller.stripe_connect_account_id);
    return c.json({ data: { enabled: true, connected: true, reseller: { ...reseller, ...updates } } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de vérifier Stripe Connect.';
    return c.json({ error: message }, 400);
  }
});

resellerRoutes.post('/stripe/connect', async (c) => {
  const { reseller } = getResellerContext(c);
  if (reseller.type !== 'stripe_connect') {
    return c.json({ error: 'Stripe Connect est réservé aux revendeurs Stripe Connect.' }, 403);
  }

  const db = createServiceClient();
  const stripe = getStripe();
  const user = c.get('user');
  let accountId = reseller.stripe_connect_account_id;
  const stripeCountry = normalizeStripeCountryCode(reseller.country);

  try {
    if (!accountId) {
      const account = await stripe.accounts.create({
        country: stripeCountry,
        email: user.email ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        controller: {
          fees: { payer: 'application' },
          losses: { payments: 'application' },
          stripe_dashboard: { type: 'express' },
          requirement_collection: 'stripe',
        },
        business_profile: {
          name: reseller.brand_name,
          support_email: reseller.support_email ?? undefined,
          url: siteUrl(),
        },
        metadata: {
          reseller_id: reseller.id,
          fidelopass_kind: 'reseller',
        },
      });
      accountId = account.id;
      await db.from('resellers').update({ stripe_connect_account_id: accountId }).eq('id', reseller.id);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${siteUrl()}/reseller/stripe?refresh=1`,
      return_url: `${siteUrl()}/reseller/stripe?connected=1`,
    });
    return c.json({ url: link.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de créer le lien Stripe Connect.';
    return c.json({ error: message }, 400);
  }
});

resellerRoutes.get('/stripe/return', async (c) => {
  return c.redirect(`${siteUrl()}/reseller/stripe?connected=1`);
});

resellerRoutes.get('/stripe/refresh', async (c) => {
  return c.redirect(`${siteUrl()}/reseller/stripe?refresh=1`);
});

resellerRoutes.get('/merchants', async (c) => {
  const { reseller } = getResellerContext(c);
  const db = createServiceClient();
  const { data, error } = await db
    .from('reseller_merchants')
    .select('*, commerces(id, nom, email, actif, billing_status)')
    .eq('reseller_id', reseller.id)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'Impossible de charger les commerçants.' }, 500);
  return c.json({ data: (data ?? []).map(normalizeMerchant) });
});

resellerRoutes.post('/merchants', async (c) => {
  const { reseller } = getResellerContext(c);
  const body = await c.req.json().catch(() => null);
  const parsed = merchantCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données commerçant invalides.' }, 400);
  }
  if (parsed.data.payment_mode === 'stripe_connect' && reseller.type !== 'stripe_connect') {
    return c.json({ error: 'Ce revendeur ne peut pas utiliser Stripe Checkout.' }, 403);
  }

  const db = createServiceClient();
  const setting = await getResellerPlanSetting(db, reseller.id, parsed.data.plan);
  const pricing = calculateResellerPricing(parsed.data.plan, parsed.data.price_cents, setting);
  const shouldActivateNow = parsed.data.activate_now && parsed.data.payment_mode !== 'stripe_connect';
  const subscriptionStatus = shouldActivateNow ? 'active' : parsed.data.creation_mode === 'invite' ? 'invited' : 'pending';

  try {
    const { data: resellerMerchant, error: insertError } = await db
      .from('reseller_merchants')
      .insert({
        reseller_id: reseller.id,
        merchant_name: parsed.data.commerce_name,
        merchant_email: parsed.data.email,
        merchant_phone: parsed.data.phone ?? null,
        country: parsed.data.country ?? reseller.country ?? null,
        plan: pricing.plan,
        reseller_price_cents: pricing.reseller_price_cents,
        platform_fee_cents: pricing.platform_fee_cents,
        reseller_margin_cents: pricing.reseller_margin_cents,
        currency: normalizeCurrency(pricing.currency, reseller.currency),
        payment_mode: parsed.data.payment_mode,
        subscription_status: subscriptionStatus,
        started_at: shouldActivateNow ? new Date().toISOString() : null,
      })
      .select('*')
      .single();
    if (insertError || !resellerMerchant) throw new Error(insertError?.message ?? 'Impossible de créer le rattachement revendeur.');

    const account = await createOrInviteMerchantUser(db, parsed.data.email, parsed.data.commerce_name, parsed.data.creation_mode);
    const commerceId = await ensureMerchantCommerce(db, {
      ownerUserId: account.userId,
      commerceName: parsed.data.commerce_name,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      country: parsed.data.country ?? reseller.country ?? null,
      resellerId: reseller.id,
      resellerMerchantId: resellerMerchant.id,
      plan: pricing.plan,
      billingStatus: shouldActivateNow ? 'active' : 'unpaid',
      paymentMode: parsed.data.payment_mode,
      resellerPriceCents: pricing.reseller_price_cents,
      platformFeeCents: pricing.platform_fee_cents,
    });

    const { data: updated, error: updateError } = await db
      .from('reseller_merchants')
      .update({ merchant_id: commerceId, updated_at: new Date().toISOString() })
      .eq('id', resellerMerchant.id)
      .select('*')
      .single();
    if (updateError) throw new Error(updateError.message);

    return c.json({ data: updated }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de créer ce commerçant.';
    return c.json({ error: message }, 400);
  }
});

resellerRoutes.get('/merchants/:id', async (c) => {
  const { reseller } = getResellerContext(c);
  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);
  const [transactionsRes, settings] = await Promise.all([
    db.from('reseller_transactions').select('*').eq('reseller_merchant_id', merchant.id).order('created_at', { ascending: false }).limit(30),
    getResellerPlanSettings(db, reseller.id),
  ]);
  return c.json({ data: merchant, transactions: transactionsRes.data ?? [], settings: Array.from(settings.values()) });
});

resellerRoutes.delete('/merchants/:id', async (c) => {
  const { reseller } = getResellerContext(c);
  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);

  if (hasActiveSubscription(merchant)) {
    return c.json({
      error: 'Impossible de supprimer un commerçant avec un abonnement actif ou Stripe. Annulez ou suspendez d’abord son abonnement.',
    }, 400);
  }

  const now = new Date().toISOString();
  if (merchant.merchant_id) {
    await db.from('commerces').update({
      reseller_id: null,
      reseller_merchant_id: null,
      reseller_payment_mode: null,
      reseller_price_cents: null,
      reseller_platform_fee_cents: null,
      updated_at: now,
    }).eq('id', merchant.merchant_id);
  }

  const { error } = await db
    .from('reseller_merchants')
    .delete()
    .eq('id', merchant.id)
    .eq('reseller_id', reseller.id);
  if (error) return c.json({ error: 'Suppression impossible.' }, 500);

  return c.json({ ok: true });
});

resellerRoutes.post('/merchants/:id/checkout', async (c) => {
  const { reseller } = getResellerContext(c);
  if (reseller.type !== 'stripe_connect') return c.json({ error: 'Revendeur Stripe Connect requis.' }, 403);
  if (!reseller.stripe_connect_account_id || !reseller.stripe_charges_enabled) {
    return c.json({ error: 'Finalisez Stripe Connect avant de créer un paiement.' }, 403);
  }

  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);
  if (merchant.payment_mode !== 'stripe_connect') return c.json({ error: 'Ce commerçant n’est pas en paiement Stripe Checkout.' }, 400);
  if (!merchant.merchant_id) return c.json({ error: 'Commerce final non créé.' }, 400);

  const stripe = getStripe();
  try {
    const customerId = merchant.stripe_customer_id
      ?? (await stripe.customers.create({
        email: merchant.merchant_email,
        name: merchant.merchant_name,
        metadata: {
          reseller_id: reseller.id,
          reseller_merchant_id: merchant.id,
          merchant_id: merchant.merchant_id,
        },
      })).id;

    const price = await createResellerStripePrice(stripe, {
      plan: merchant.plan,
      amountCents: merchant.reseller_price_cents,
      currency: merchant.currency,
      resellerId: reseller.id,
      merchantId: merchant.merchant_id,
    });

    const metadata = {
      kind: 'reseller_merchant_subscription',
      reseller_id: reseller.id,
      reseller_merchant_id: merchant.id,
      merchant_id: merchant.merchant_id,
      plan: merchant.plan,
      reseller_price_cents: String(merchant.reseller_price_cents),
      platform_fee_cents: String(merchant.platform_fee_cents),
      reseller_margin_cents: String(merchant.reseller_margin_cents),
      currency: merchant.currency,
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${siteUrl()}/reseller/merchants/${merchant.id}?checkout=success`,
      cancel_url: `${siteUrl()}/reseller/merchants/${merchant.id}?checkout=cancelled`,
      locale: 'fr',
      allow_promotion_codes: false,
      metadata,
      subscription_data: {
        application_fee_percent: stripeApplicationFeePercent(merchant.platform_fee_cents, merchant.reseller_price_cents),
        transfer_data: { destination: reseller.stripe_connect_account_id },
        metadata,
      },
    });

    await db.from('reseller_merchants').update({
      stripe_customer_id: customerId,
      stripe_checkout_session_id: session.id,
      subscription_status: 'incomplete',
      updated_at: new Date().toISOString(),
    }).eq('id', merchant.id);

    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de créer la session Stripe.';
    return c.json({ error: message }, 400);
  }
});

resellerRoutes.post('/merchants/:id/manual-activate', async (c) => {
  const { reseller } = getResellerContext(c);
  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);
  if (merchant.payment_mode === 'stripe_connect') return c.json({ error: 'Utilisez Stripe Checkout pour ce commerçant.' }, 400);

  const now = new Date().toISOString();
  await db.from('reseller_merchants').update({
    subscription_status: 'active',
    started_at: merchant.started_at ?? now,
    cancelled_at: null,
    updated_at: now,
  }).eq('id', merchant.id);
  if (merchant.merchant_id) {
    await db.from('commerces').update({
      plan: resellerPlanToCommercePlan(merchant.plan),
      billing_status: 'active',
      actif: true,
      updated_at: now,
    }).eq('id', merchant.merchant_id);
  }

  return c.json({ ok: true });
});

resellerRoutes.post('/merchants/:id/change-plan', async (c) => {
  const { reseller } = getResellerContext(c);
  const body = await c.req.json().catch(() => null);
  const parsed = merchantChangePlanSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Plan ou prix invalide.' }, 400);

  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);

  const setting = await getResellerPlanSetting(db, reseller.id, parsed.data.plan);
  const pricing = calculateResellerPricing(parsed.data.plan, parsed.data.price_cents, setting);
  const now = new Date().toISOString();

  try {
    if (merchant.stripe_subscription_id && reseller.type === 'stripe_connect' && reseller.stripe_connect_account_id) {
      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(merchant.stripe_subscription_id);
      const itemId = subscription.items.data[0]?.id;
      if (!itemId) throw new Error('Abonnement Stripe sans ligne tarifaire.');
      const price = await createResellerStripePrice(stripe, {
        plan: pricing.plan,
        amountCents: pricing.reseller_price_cents,
        currency: pricing.currency,
        resellerId: reseller.id,
        merchantId: merchant.merchant_id,
      });
      const metadata = {
        kind: 'reseller_merchant_subscription',
        reseller_id: reseller.id,
        reseller_merchant_id: merchant.id,
        merchant_id: merchant.merchant_id ?? '',
        plan: pricing.plan,
        reseller_price_cents: String(pricing.reseller_price_cents),
        platform_fee_cents: String(pricing.platform_fee_cents),
        reseller_margin_cents: String(pricing.reseller_margin_cents),
        currency: pricing.currency,
      };
      await stripe.subscriptions.update(merchant.stripe_subscription_id, {
        items: [{ id: itemId, price: price.id }],
        proration_behavior: 'create_prorations',
        application_fee_percent: stripeApplicationFeePercent(pricing.platform_fee_cents, pricing.reseller_price_cents),
        transfer_data: { destination: reseller.stripe_connect_account_id },
        metadata,
      } as Stripe.SubscriptionUpdateParams);
    }

    const { data, error } = await db.from('reseller_merchants').update({
      plan: pricing.plan,
      reseller_price_cents: pricing.reseller_price_cents,
      platform_fee_cents: pricing.platform_fee_cents,
      reseller_margin_cents: pricing.reseller_margin_cents,
      currency: pricing.currency,
      updated_at: now,
    }).eq('id', merchant.id).select('*').single();
    if (error) throw new Error(error.message);
    if (merchant.merchant_id) {
      await db.from('commerces').update({
        plan: resellerPlanToCommercePlan(pricing.plan),
        reseller_price_cents: pricing.reseller_price_cents,
        reseller_platform_fee_cents: pricing.platform_fee_cents,
        updated_at: now,
      }).eq('id', merchant.merchant_id);
    }
    return c.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de changer le plan.';
    return c.json({ error: message }, 400);
  }
});

resellerRoutes.post('/merchants/:id/cancel', async (c) => {
  const { reseller } = getResellerContext(c);
  const body = await c.req.json().catch(() => null);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Paramètres invalides.' }, 400);

  const db = createServiceClient();
  const merchant = await loadOwnedResellerMerchant(db, reseller.id, c.req.param('id'));
  if (!merchant) return c.json({ error: 'Commerçant introuvable.' }, 404);
  const now = new Date().toISOString();

  try {
    if (merchant.stripe_subscription_id && !parsed.data.suspend) {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(merchant.stripe_subscription_id);
    }
    const status = parsed.data.suspend ? 'suspended' : 'cancelled';
    await db.from('reseller_merchants').update({
      subscription_status: status,
      cancelled_at: parsed.data.suspend ? null : now,
      updated_at: now,
    }).eq('id', merchant.id);
    if (merchant.merchant_id) {
      await db.from('commerces').update({
        billing_status: parsed.data.suspend ? 'past_due' : 'canceled',
        actif: false,
        updated_at: now,
      }).eq('id', merchant.merchant_id);
    }
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de suspendre ou annuler.';
    return c.json({ error: message }, 400);
  }
});
