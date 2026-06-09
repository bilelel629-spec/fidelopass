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
  loadRuntimePriceIds,
  type PriceSlot,
  resolvePriceSlot,
  resolveExpectedModeFromSlot,
  resolveCommitmentLabelFromSlot,
  resolvePlanFromSlot,
  resolveUsablePriceId,
  LEGACY_PRICE_IDS,
  loadPriceIds,
} from '../services/stripe-billing';
import { sendWelcomeEmail } from '../services/welcome-email';

export const checkoutRoutes = new Hono<ApiEnv>();

const createSessionSchema = z.object({
  priceId: z.string().min(1),
  mode: z.enum(['subscription', 'payment']),
  priceSlot: z.string().optional(),
  includeAccompagnement: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

function pricingItem(slot: string, priceIds: Record<string, string>) {
  const priceId = priceIds[slot] ?? '';
  const isLegacyPrice = Object.prototype.hasOwnProperty.call(LEGACY_PRICE_IDS, slot)
    && LEGACY_PRICE_IDS[slot as keyof typeof LEGACY_PRICE_IDS].includes(priceId);
  return {
    slot,
    priceId,
    mode: resolveExpectedModeFromSlot(slot as PriceSlot),
    available: Boolean(priceId) && !isLegacyPrice,
  };
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
  let priceIds: Record<PriceSlot, string>;
  let meta: ReturnType<typeof getPriceIdsDiagnostics>;
  try {
    priceIds = await loadRuntimePriceIds();
    meta = getPriceIdsDiagnostics(priceIds);
    if (meta.missingRequiredSlots.length > 0) {
      console.warn('[checkout] pricing-config missing required slots', meta);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Configuration Stripe indisponible.';
    console.error('[checkout] pricing-config error:', message);
    priceIds = loadPriceIds();
    meta = getPriceIdsDiagnostics(priceIds);
  }
  const starterAnnual = pricingItem('starter_annuel_once', priceIds);
  const proAnnual = pricingItem('pro_annuel_once', priceIds);
  const businessAnnual = pricingItem('business_annuel_once', priceIds);
  return c.json({
    degraded: meta.missingRequiredSlots.length > 0,
    meta,
    data: {
      starter: {
        monthly: pricingItem('starter_mensuel', priceIds),
        annual: starterAnnual,
        annual_once: starterAnnual,
        annual_monthly: null,
      },
      pro: {
        monthly: pricingItem('pro_mensuel', priceIds),
        annual: proAnnual,
        annual_once: proAnnual,
        annual_monthly: null,
      },
      business: {
        monthly: pricingItem('business_mensuel', priceIds),
        annual: businessAnnual,
        annual_once: businessAnnual,
        annual_monthly: null,
      },
      addons: {
        accompagnement: pricingItem('accompagnement', priceIds),
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

  const { priceId, mode, includeAccompagnement, dryRun } = parsed.data;
  let stripe: Stripe;
  let priceIds: Record<PriceSlot, string>;
  try {
    stripe = getStripe({ maxNetworkRetries: 1 });
    priceIds = await loadRuntimePriceIds(stripe);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Configuration Stripe indisponible.';
    console.error('[checkout] stripe configuration error:', message);
    return stripeConfigErrorResponse(c, error);
  }
  const selectedSlot = resolvePriceSlot(priceId, priceIds);

  if (!selectedSlot) {
    return c.json({ error: 'Prix Stripe invalide.' }, 400);
  }
  if (LEGACY_PRICE_IDS[selectedSlot]?.includes(priceId)) {
    return c.json({ error: 'Ce tarif Stripe correspond à une ancienne grille. Configurez le nouveau Price ID avant de créer le paiement.' }, 409);
  }

  const expectedMode = resolveExpectedModeFromSlot(selectedSlot);
  const selectedPlan = resolvePlanFromSlot(selectedSlot);
  const isPlanCheckout = selectedPlan !== null;
  const isAccompagnementOnly = selectedSlot === 'accompagnement';

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
    .select('id, stripe_customer_id, stripe_subscription_id, billing_status, onboarding_purchased, trial_ends_at')
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
      .select('id, stripe_customer_id, stripe_subscription_id, billing_status, onboarding_purchased')
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

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

  if (isAccompagnementOnly) {
    if (mode !== 'payment') {
      return c.json({ error: "L'accompagnement Setup doit être payé en une fois." }, 400);
    }
    if (commerce.onboarding_purchased) {
      return c.json({ error: 'Accompagnement Setup déjà activé pour ce commerce.' }, 409);
    }

    const resolvedAccompagnementPriceId = await resolveUsablePriceId(stripe, 'accompagnement', priceId, priceIds);
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: [{ price: resolvedAccompagnementPriceId, quantity: 1 }],
      success_url: `${PUBLIC_SITE_URL}/dashboard/assistant-carte?checkout=success`,
      cancel_url: `${PUBLIC_SITE_URL}/dashboard/assistant-carte?checkout=cancelled`,
      locale: 'fr',
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      metadata: {
        commerce_id: commerce.id,
        user_id: userId,
        base_price_id: resolvedAccompagnementPriceId,
        requested_base_price_id: priceId,
        selected_price_slot: 'accompagnement',
        selected_plan: '',
        onboarding_addon: 'true',
        billing_commitment: 'unknown',
      },
      ...(commerce.stripe_customer_id ? { customer: commerce.stripe_customer_id } : email ? { customer_email: email } : {}),
    };

    try {
      const session = await stripe.checkout.sessions.create(sessionParams);
      return c.json({ url: session.url });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur Stripe lors de la création de session.';
      console.error('[checkout] create-accompagnement-session error:', message);
      return c.json({ error: message }, 400);
    }
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

  const resolvedBasePriceId = await resolveUsablePriceId(stripe, selectedSlot, priceId, priceIds);
  const resolvedAccompagnementPriceId = includeAccompagnement
    ? await resolveUsablePriceId(stripe, 'accompagnement', priceIds.accompagnement, priceIds)
    : null;

  if (dryRun) {
    return c.json({
      ok: true,
      data: {
        selectedSlot,
        selectedPlan,
        mode,
        resolvedBasePriceId,
        resolvedAccompagnementPriceId,
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
  if (resolvedAccompagnementPriceId) {
    lineItems.push({ price: resolvedAccompagnementPriceId, quantity: 1 });
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: 'fr',
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    metadata: {
      commerce_id: commerce.id,
      user_id: userId,
      base_price_id: resolvedBasePriceId,
      requested_base_price_id: priceId,
      selected_price_slot: selectedSlot,
      selected_plan: selectedPlan ?? '',
      onboarding_addon: includeAccompagnement ? 'true' : 'false',
      billing_commitment: resolveCommitmentLabelFromSlot(selectedSlot),
    },
    ...(commerce.stripe_customer_id ? { customer: commerce.stripe_customer_id } : email ? { customer_email: email } : {}),
  };

  if (mode === 'subscription') {
    // L'essai gratuit n'est accordé qu'une seule fois. Un commerce qui a déjà eu
    // un essai (trial_ends_at renseigné) ne le reçoit pas une seconde fois.
    const hasUsedTrial = Boolean((commerce as { trial_ends_at?: string | null }).trial_ends_at);
    sessionParams.subscription_data = {
      ...(hasUsedTrial ? {} : { trial_period_days: 14 }),
      metadata: {
        commerce_id: commerce.id,
        user_id: userId,
        base_price_id: resolvedBasePriceId,
        requested_base_price_id: priceId,
        selected_price_slot: selectedSlot,
        selected_plan: selectedPlan ?? '',
        onboarding_addon: includeAccompagnement ? 'true' : 'false',
        billing_commitment: resolveCommitmentLabelFromSlot(selectedSlot),
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
  const priceIds = loadPriceIds();

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
