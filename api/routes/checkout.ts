import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth';
import { createServiceClient } from '../../src/lib/supabase';
import {
  getStripe,
  getPriceIdsDiagnostics,
  formatBillingAmount,
  loadPriceCatalog,
  loadRuntimePriceIds,
  normalizeBillingCountry,
  normalizeBillingCurrency,
  currencyForCountry,
  type BillingCountry,
  type BillingCurrency,
  type PlanName,
  type PriceSlot,
  resolveExpectedModeFromSlot,
  resolveCommitmentLabelFromSlot,
  resolvePlanFromSlot,
  resolvePriceSlot,
  resolveUsablePriceId,
  isLegacyPriceId,
  PUBLIC_PRICE_AMOUNTS,
  loadPriceIds,
} from '../services/stripe-billing';
import { sendWelcomeEmail } from '../services/welcome-email';

export const checkoutRoutes = new Hono<ApiEnv>();

const createSessionSchema = z.object({
  purchase: z.enum(['subscription', 'accompagnement']).optional().default('subscription'),
  plan: z.enum(['starter', 'pro', 'business']).optional(),
  interval: z.enum(['monthly', 'yearly']).optional(),
  currency: z.enum(['eur', 'chf']),
  country: z.enum(['FR', 'CH']).nullable().optional(),
  includeAccompagnement: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.purchase === 'subscription' && (!value.plan || !value.interval)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Le plan et la périodicité sont obligatoires.',
    });
  }
});

function pricingItem(slot: PriceSlot, priceIds: Record<string, string>, currency: BillingCurrency) {
  const priceId = priceIds[slot] ?? '';
  const amount = PUBLIC_PRICE_AMOUNTS[currency][slot] ?? null;
  return {
    slot,
    mode: resolveExpectedModeFromSlot(slot as PriceSlot),
    currency,
    amountCents: amount,
    formattedAmount: amount === null ? null : formatBillingAmount(amount, currency),
    available: Boolean(priceId) && (currency === 'chf' || !isLegacyPriceId(slot, priceId)),
  };
}

function resolveRequestCountry(c: Context<ApiEnv>): BillingCountry | null {
  return normalizeBillingCountry(
    c.req.header('cf-ipcountry')
    ?? c.req.header('x-vercel-ip-country')
    ?? c.req.header('x-country-code')
    ?? c.req.header('x-country'),
  );
}

function resolvePlanSlot(plan: PlanName, interval: 'monthly' | 'yearly'): PriceSlot {
  return `${plan}_${interval === 'yearly' ? 'annuel_once' : 'mensuel'}` as PriceSlot;
}

function stripeConfigErrorResponse(c: Context<ApiEnv>, error: unknown) {
  const message = error instanceof Error ? error.message : 'Configuration Stripe indisponible.';
  if (
    message.includes('STRIPE_SECRET_KEY')
    || message.includes('Clé Stripe test interdite')
    || message.toLowerCase().includes('stripe')
  ) {
    return c.json({ error: message }, 503);
  }
  return c.json({ error: message }, 400);
}

/** GET /api/checkout/pricing-config */
checkoutRoutes.get('/pricing-config', authMiddleware, async (c) => {
  const detectedCountry = resolveRequestCountry(c);
  const requestedCurrency = c.req.query('currency');
  const currency = requestedCurrency === 'chf' || requestedCurrency === 'eur'
    ? normalizeBillingCurrency(requestedCurrency)
    : currencyForCountry(detectedCountry);
  let priceIds: Record<PriceSlot, string>;
  let meta: ReturnType<typeof getPriceIdsDiagnostics>;
  try {
    priceIds = await loadRuntimePriceIds(undefined, currency);
    meta = getPriceIdsDiagnostics(priceIds, currency);
    if (meta.missingRequiredSlots.length > 0) {
      console.warn('[checkout] pricing-config missing required slots', meta);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Configuration Stripe indisponible.';
    console.error('[checkout] pricing-config error:', message);
    priceIds = loadPriceIds(currency);
    meta = getPriceIdsDiagnostics(priceIds, currency);
  }
  const starterAnnual = pricingItem('starter_annuel_once', priceIds, currency);
  const proAnnual = pricingItem('pro_annuel_once', priceIds, currency);
  const businessAnnual = pricingItem('business_annuel_once', priceIds, currency);
  return c.json({
    degraded: meta.missingRequiredSlots.length > 0,
    meta,
    currency,
    country: detectedCountry,
    data: {
      starter: {
        monthly: pricingItem('starter_mensuel', priceIds, currency),
        annual: starterAnnual,
        annual_once: starterAnnual,
        annual_monthly: null,
      },
      pro: {
        monthly: pricingItem('pro_mensuel', priceIds, currency),
        annual: proAnnual,
        annual_once: proAnnual,
        annual_monthly: null,
      },
      business: {
        monthly: pricingItem('business_mensuel', priceIds, currency),
        annual: businessAnnual,
        annual_once: businessAnnual,
        annual_monthly: null,
      },
      addons: {
        accompagnement: pricingItem('accompagnement', priceIds, currency),
      },
    },
  });
});

/** POST /api/checkout/create-session */
checkoutRoutes.post('/create-session', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = createSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const {
    purchase,
    plan,
    interval,
    currency,
    includeAccompagnement,
    dryRun,
  } = parsed.data;
  const country = normalizeBillingCountry(parsed.data.country) ?? resolveRequestCountry(c);
  const selectedSlot = purchase === 'accompagnement'
    ? 'accompagnement'
    : resolvePlanSlot(plan as PlanName, interval as 'monthly' | 'yearly');
  const mode: 'subscription' | 'payment' = purchase === 'accompagnement' ? 'payment' : 'subscription';
  let stripe: Stripe;
  let priceIds: Record<PriceSlot, string>;
  try {
    stripe = getStripe({ maxNetworkRetries: 1 });
    priceIds = await loadRuntimePriceIds(stripe, currency);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Configuration Stripe indisponible.';
    console.error('[checkout] stripe configuration error:', message);
    return stripeConfigErrorResponse(c, error);
  }
  const requestedPriceId = priceIds[selectedSlot];
  if (!requestedPriceId) {
    return c.json({ error: `Le tarif ${currency.toUpperCase()} sélectionné n'est pas encore configuré.` }, 503);
  }

  const expectedMode = resolveExpectedModeFromSlot(selectedSlot);
  const selectedPlan = resolvePlanFromSlot(selectedSlot);
  const isPlanCheckout = selectedPlan !== null;
  const isAccompagnementOnly = purchase === 'accompagnement';

  if (mode !== expectedMode) {
    return c.json({
      error: expectedMode === 'payment'
        ? 'Cet achat doit être payé en une fois.'
        : 'Ce plan doit être payé en mode abonnement.',
    }, 400);
  }

  if (includeAccompagnement && !isPlanCheckout) {
    return c.json({ error: "L'option Accompagnement Setup ne peut être ajoutée qu'à un abonnement Starter, Pro ou Business." }, 400);
  }

  const db = createServiceClient();
  const { data: { user } } = await db.auth.admin.getUserById(userId);
  const email = user?.email ?? undefined;

  const { data: existingCommerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id, stripe_subscription_id, billing_status, onboarding_purchased, trial_ends_at, billing_currency, billing_country, billing_currency_locked_at')
    .eq('user_id', userId)
    .single();

  let commerce = existingCommerce;
  if (!commerce) {
    const commerceName = 'Mon commerce';
    const { data: createdCommerce, error: createCommerceError } = await db
      .from('commerces')
      .insert({
        user_id: userId,
        nom: commerceName,
        email: email ?? null,
        onboarding_completed: false,
        billing_status: 'unpaid',
      })
      .select('id, stripe_customer_id, stripe_subscription_id, billing_status, onboarding_purchased, trial_ends_at, billing_currency, billing_country, billing_currency_locked_at')
      .single();
    if (createCommerceError || !createdCommerce) {
      return c.json({ error: "Impossible d'initialiser le commerce avant le paiement." }, 500);
    }
    commerce = createdCommerce;
    if (email) {
      const welcomeResult = await sendWelcomeEmail({ toEmail: email, commerceName });
      if (!welcomeResult.ok && !welcomeResult.skipped) {
        console.warn('[checkout] welcome email failed for new commerce');
      }
    }
  }
  if (!commerce) {
    return c.json({ error: "Commerce introuvable." }, 500);
  }

  const lockedCurrency = normalizeBillingCurrency(commerce.billing_currency);
  if (commerce.billing_currency_locked_at && lockedCurrency !== currency) {
    return c.json({
      error: `Ce compte est déjà rattaché à la devise ${lockedCurrency.toUpperCase()}.`,
      code: 'BILLING_CURRENCY_LOCKED',
    }, 409);
  }

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

  if (isAccompagnementOnly) {
    if (commerce.onboarding_purchased) {
      return c.json({ error: 'Accompagnement Setup déjà activé pour ce commerce.' }, 409);
    }

    const { error: activateError } = await db
      .from('commerces')
      .update({
        onboarding_purchased: true,
        billing_currency: currency,
        billing_country: country ?? (currency === 'chf' ? 'CH' : 'FR'),
        billing_currency_locked_at: commerce.billing_currency_locked_at ?? new Date().toISOString(),
      })
      .eq('id', commerce.id);

    if (activateError) {
      console.error('[checkout] free-accompagnement-activation error:', activateError.message);
      return c.json({ error: "Impossible d'activer l'accompagnement." }, 500);
    }

    return c.json({ url: `${PUBLIC_SITE_URL}/dashboard/assistant-carte?activated=1` });
  }

  if (
    isPlanCheckout
    && commerce.stripe_subscription_id
    && ['active', 'trialing', 'past_due', 'incomplete'].includes(String(commerce.billing_status ?? '').toLowerCase())
  ) {
    return c.json({
      error: 'Un abonnement existe déjà pour ce commerce. Utilisez la gestion d’abonnement pour changer de plan.',
    }, 409);
  }

  const resolvedBasePriceId = await resolveUsablePriceId(stripe, selectedSlot, requestedPriceId, priceIds);
  const activatesAccompagnement = Boolean(isPlanCheckout);

  if (dryRun) {
    return c.json({
      ok: true,
      data: {
        selectedSlot,
        selectedPlan,
        mode,
        currency,
        country,
        resolvedBasePriceId,
        resolvedAccompagnementPriceId: null,
        activatesAccompagnement,
      },
    });
  }

  const successUrl = isPlanCheckout
    ? `${PUBLIC_SITE_URL}/dashboard?tour=1`
    : `${PUBLIC_SITE_URL}/dashboard/parametres?tab=abonnement&checkout=success`;
  const cancelUrl = isPlanCheckout
    ? `${PUBLIC_SITE_URL}/abonnement/choix?cancelled=1`
    : `${PUBLIC_SITE_URL}/dashboard/parametres?tab=abonnement&checkout=cancelled`;

  const lineItems = [{ price: resolvedBasePriceId, quantity: 1 }];

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: 'fr',
    automatic_tax: { enabled: false },
    metadata: {
      commerce_id: commerce.id,
      user_id: userId,
      base_price_id: resolvedBasePriceId,
      requested_base_price_id: resolvedBasePriceId,
      selected_price_slot: selectedSlot,
      selected_plan: selectedPlan ?? '',
      onboarding_addon: activatesAccompagnement ? 'true' : 'false',
      billing_commitment: resolveCommitmentLabelFromSlot(selectedSlot),
      billing_currency: currency,
      billing_country: country ?? '',
    },
    ...(commerce.stripe_customer_id ? { customer: commerce.stripe_customer_id } : email ? { customer_email: email } : {}),
  };

  if (mode === 'subscription') {
    sessionParams.allow_promotion_codes = true;
    // L'essai gratuit n'est accordé qu'une seule fois. Un commerce qui a déjà eu
    // un essai (trial_ends_at renseigné) ne le reçoit pas une seconde fois.
    const hasUsedTrial = Boolean((commerce as { trial_ends_at?: string | null }).trial_ends_at);
    sessionParams.subscription_data = {
      ...(hasUsedTrial ? {} : { trial_period_days: 14 }),
      metadata: {
        commerce_id: commerce.id,
        user_id: userId,
        base_price_id: resolvedBasePriceId,
        requested_base_price_id: resolvedBasePriceId,
        selected_price_slot: selectedSlot,
        selected_plan: selectedPlan ?? '',
        onboarding_addon: activatesAccompagnement ? 'true' : 'false',
        billing_commitment: resolveCommitmentLabelFromSlot(selectedSlot),
        billing_currency: currency,
        billing_country: country ?? '',
      },
    };
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erreur Stripe lors de la création de session.';
    console.error('[checkout] create-session error:', message);
    return c.json({ error: message }, 400);
  }
});

/** POST /api/checkout/create-portal-session */
checkoutRoutes.post('/create-portal-session', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const priceIds = loadPriceCatalog();

  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id, stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (!commerce) {
    return c.json({ error: 'Commerce introuvable.' }, 404);
  }

  const stripe = getStripe();
  let customerId = commerce.stripe_customer_id;

  if (!customerId) {
    const { data: { user } } = await db.auth.admin.getUserById(userId);
    const email = user?.email;
    if (!email) {
      return c.json({ error: "Aucun email de facturation disponible pour ouvrir l'espace Stripe." }, 400);
    }

    const customer = await stripe.customers.create({
      email,
      metadata: {
        user_id: userId,
        commerce_id: commerce.id,
      },
    });
    customerId = customer.id;

    await db
      .from('commerces')
      .update({ stripe_customer_id: customerId })
      .eq('id', commerce.id);
  }

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
  try {
    const returnUrl = `${PUBLIC_SITE_URL}/dashboard/parametres?tab=abonnement`;
    const subscriptionId = commerce.stripe_subscription_id;
    let session: Stripe.BillingPortal.Session;

    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const commitment = String(subscription.metadata?.billing_commitment ?? '').toLowerCase();
      const subscriptionPriceId = subscription.items?.data?.[0]?.price?.id ?? null;
      const subscriptionSlot = subscriptionPriceId ? resolvePriceSlot(subscriptionPriceId, priceIds) : null;

      const isAnnualCommitment = commitment === 'annual-12m-monthly'
        || subscriptionSlot === 'starter_annuel_mensuel'
        || subscriptionSlot === 'pro_annuel_mensuel'
        || subscriptionSlot === 'business_annuel_mensuel';

      if (isAnnualCommitment) {
        const startTsMs = (subscription.start_date ?? Math.floor(Date.now() / 1000)) * 1000;
        const commitmentEndMs = startTsMs + (365 * 24 * 60 * 60 * 1000);
        const stillLocked = Date.now() < commitmentEndMs
          && ['active', 'trialing', 'past_due', 'incomplete'].includes(subscription.status);

        if (stillLocked) {
          session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
            flow_data: {
              type: 'payment_method_update',
              after_completion: {
                type: 'redirect',
                redirect: {
                  return_url: `${returnUrl}&billing=updated`,
                },
              },
            },
          });
          return c.json({
            url: session.url,
            commitment_locked: true,
            engagement_until: new Date(commitmentEndMs).toISOString(),
          });
        }
      }
    }

    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible d’ouvrir l’espace de gestion Stripe.';
    console.error('[checkout] create-portal-session error:', message);
    return c.json({ error: message }, 400);
  }
});
