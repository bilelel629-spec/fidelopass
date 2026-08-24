import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import type Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth';
import { getBillingStatusForUser } from '../services/billing';
import { createServiceClient } from '../../src/lib/supabase';
import {
  PLAN_PRICE_SLOTS,
  buildSubscriptionBillingUpdate,
  getCommitmentEndIso,
  getStripe,
  isAnnualMonthlyCommitment,
  loadPriceCatalog,
  loadPriceIds,
  normalizeBillingCurrency,
  type PriceSlot,
  resolveBillingIntervalFromSlot,
  resolveCommitmentLabelFromSlot,
  resolvePriceSlot,
  resolvePlanFromSlot,
  resolveUsablePriceId,
} from '../services/stripe-billing';

export const billingRoutes = new Hono<ApiEnv>();

billingRoutes.use('*', authMiddleware);

const portalSchema = z.object({
  flow: z.enum(['manage', 'cancel', 'payment_method', 'change_plan']).optional().default('manage'),
});

const changePlanSchema = z.object({
  plan: z.enum(['starter', 'pro', 'business']),
  interval: z.enum(['monthly', 'yearly']),
});

/** GET /api/billing/status — statut d'accès abonnement pour l'utilisateur connecté */
billingRoutes.get('/status', async (c) => {
  const userId = c.get('userId') as string;
  const userEmail = (c.get('user') as { email?: string } | undefined)?.email;
  const data = await getBillingStatusForUser(userId, userEmail);
  const response = c.json({ data });
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
});

/** POST /api/billing/change-plan — change le prix de l'abonnement sans dépendre du Billing Portal */
billingRoutes.post('/change-plan', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => ({}));
  const parsed = changePlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Plan cible invalide.' }, 400);
  }

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (!commerce?.stripe_subscription_id) {
    return c.json({ error: 'Aucun abonnement Stripe actif à modifier.' }, 400);
  }

  try {
    const stripe = getStripe();
    const catalog = loadPriceCatalog();
    const subscription = await stripe.subscriptions.retrieve(commerce.stripe_subscription_id);
    const currentCurrency = normalizeBillingCurrency(subscription.items?.data?.[0]?.price?.currency);
    const priceIds = loadPriceIds(currentCurrency);
    const targetSlot = `${parsed.data.plan}_${parsed.data.interval === 'yearly' ? 'annuel_once' : 'mensuel'}` as PriceSlot;
    const targetPlan = resolvePlanFromSlot(targetSlot);

    if (!targetPlan) {
      return c.json({ error: 'Le plan cible est invalide.' }, 400);
    }

    const subscriptionItemId = subscription.items?.data?.[0]?.id;
    if (!subscriptionItemId) {
      return c.json({ error: "Impossible d'identifier la ligne d'abonnement Stripe à modifier." }, 400);
    }

    if (subscription.cancel_at_period_end) {
      return c.json({
        error: "Réactivez d'abord l'abonnement avant de changer de plan.",
        code: 'SUBSCRIPTION_CANCEL_SCHEDULED',
      }, 409);
    }

    const currentPriceId = subscription.items?.data?.[0]?.price?.id ?? null;
    const currentSlot = resolvePriceSlot(currentPriceId, catalog);
    const commitment = String(subscription.metadata?.billing_commitment ?? '').toLowerCase();

    if (isAnnualMonthlyCommitment(currentSlot, commitment)) {
      const engagementUntil = getCommitmentEndIso(subscription.start_date);
      const stillLocked = Date.now() < Date.parse(engagementUntil)
        && ['active', 'trialing', 'past_due', 'incomplete'].includes(subscription.status);

      if (stillLocked) {
        return c.json({
          error: "Cet abonnement est engagé sur 12 mois. Les changements seront possibles à la fin de l'engagement.",
          code: 'COMMITMENT_LOCKED',
          engagement_until: engagementUntil,
        }, 409);
      }
    }

    const requestedPriceId = priceIds[targetSlot];
    if (!requestedPriceId) {
      return c.json({ error: `Le tarif ${currentCurrency.toUpperCase()} demandé n'est pas configuré.` }, 503);
    }
    const usablePriceId = await resolveUsablePriceId(stripe, targetSlot, requestedPriceId, priceIds);
    const updatedSubscription = await stripe.subscriptions.update(commerce.stripe_subscription_id, {
      items: [{ id: subscriptionItemId, price: usablePriceId, quantity: 1 }],
      metadata: {
        ...subscription.metadata,
        selected_plan: targetPlan,
        billing_commitment: resolveCommitmentLabelFromSlot(targetSlot),
        billing_interval: resolveBillingIntervalFromSlot(targetSlot) ?? '',
        billing_currency: currentCurrency,
      },
      payment_behavior: 'pending_if_incomplete',
      proration_behavior: 'create_prorations',
    });

    const { updates } = buildSubscriptionBillingUpdate(updatedSubscription, catalog);
    await db.from('commerces').update(updates).eq('id', commerce.id);

    return c.json({
      data: {
        plan: updates.plan ?? targetPlan,
        stripe_price_id: updates.stripe_price_id ?? usablePriceId,
        billing_status: updates.billing_status ?? updatedSubscription.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de changer de plan.';
    console.error('[billing] change-plan error:', message);
    return c.json({ error: message }, 400);
  }
});

/** GET /api/billing/prices — prix publics utiles pour les changements de plan */
billingRoutes.get('/prices', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('billing_currency')
    .eq('user_id', userId)
    .single();
  const currency = normalizeBillingCurrency(commerce?.billing_currency);
  const priceIds = loadPriceIds(currency);
  const data = PLAN_PRICE_SLOTS
    .map((slot) => ({
      slot,
      available: Boolean(priceIds[slot]),
      plan: resolvePlanFromSlot(slot),
      currency,
    }))
    .filter((item) => item.available);

  return c.json({ data });
});

/** POST /api/billing/portal — ouvre Stripe Billing Portal avec le bon flux */
billingRoutes.post('/portal', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => ({}));
  const parsed = portalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides.' }, 400);
  }

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id, stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable.' }, 404);

  const stripe = getStripe();
  const priceIds = loadPriceCatalog();
  let customerId = commerce.stripe_customer_id as string | null;
  const subscriptionId = commerce.stripe_subscription_id as string | null;

  if (!customerId && subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;
    if (customerId) {
      await db.from('commerces').update({ stripe_customer_id: customerId }).eq('id', commerce.id);
    }
  }

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
    await db.from('commerces').update({ stripe_customer_id: customerId }).eq('id', commerce.id);
  }

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
  const returnUrl = `${PUBLIC_SITE_URL}/dashboard/parametres?tab=abonnement`;
  const { flow } = parsed.data;

  try {
    if (flow === 'change_plan') {
      return c.json({
        error: "Le changement de plan se fait désormais depuis l'application Fidelopass. Rechargez la page puis réessayez.",
        code: 'CHANGE_PLAN_ROUTE_REQUIRED',
      }, 409);
    }

    let flowData: Stripe.BillingPortal.SessionCreateParams['flow_data'] | undefined;

    if (flow !== 'manage') {
      if (!subscriptionId && flow !== 'payment_method') {
        return c.json({ error: 'Aucun abonnement Stripe actif à modifier.' }, 400);
      }

      if (flow === 'payment_method') {
        flowData = {
          type: 'payment_method_update',
          after_completion: {
            type: 'redirect',
            redirect: { return_url: `${returnUrl}&billing=payment-updated` },
          },
        };
      } else if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const currentPriceId = subscription.items?.data?.[0]?.price?.id ?? null;
        const currentSlot = resolvePriceSlot(currentPriceId, priceIds);
        const commitment = String(subscription.metadata?.billing_commitment ?? '').toLowerCase();

        if (isAnnualMonthlyCommitment(currentSlot, commitment)) {
          const engagementUntil = getCommitmentEndIso(subscription.start_date);
          const stillLocked = Date.now() < Date.parse(engagementUntil)
            && ['active', 'trialing', 'past_due', 'incomplete'].includes(subscription.status);

          if (stillLocked) {
            return c.json({
              error: "Cet abonnement est engagé sur 12 mois. Les changements seront possibles à la fin de l'engagement.",
              code: 'COMMITMENT_LOCKED',
              engagement_until: engagementUntil,
            }, 409);
          }
        }

        if (flow === 'cancel') {
          flowData = {
            type: 'subscription_cancel',
            subscription_cancel: { subscription: subscriptionId },
            after_completion: {
              type: 'redirect',
              redirect: { return_url: `${returnUrl}&billing=cancel-scheduled` },
            },
          };
        }
      }
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(flowData ? { flow_data: flowData } : {}),
    });

    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible d’ouvrir l’espace de gestion Stripe.';
    console.error('[billing] portal error:', message);
    return c.json({ error: message }, 400);
  }
});

/** POST /api/billing/cancel — programme l'annulation à la fin de la période Stripe */
billingRoutes.post('/cancel', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (!commerce?.stripe_subscription_id) {
    return c.json({ error: 'Aucun abonnement Stripe actif à annuler.' }, 400);
  }

  try {
    const stripe = getStripe();
    const priceIds = loadPriceCatalog();
    const subscription = await stripe.subscriptions.retrieve(commerce.stripe_subscription_id);
    const currentPriceId = subscription.items?.data?.[0]?.price?.id ?? null;
    const currentSlot = resolvePriceSlot(currentPriceId, priceIds);
    const commitment = String(subscription.metadata?.billing_commitment ?? '').toLowerCase();

    if (isAnnualMonthlyCommitment(currentSlot, commitment)) {
      const engagementUntil = getCommitmentEndIso(subscription.start_date);
      const stillLocked = Date.now() < Date.parse(engagementUntil)
        && ['active', 'trialing', 'past_due', 'incomplete'].includes(subscription.status);

      if (stillLocked) {
        return c.json({
          error: "Cet abonnement est engagé sur 12 mois. L'annulation sera possible à la fin de l'engagement.",
          code: 'COMMITMENT_LOCKED',
          engagement_until: engagementUntil,
        }, 409);
      }
    }

    const updatedSubscription = await stripe.subscriptions.update(commerce.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    const { updates } = buildSubscriptionBillingUpdate(updatedSubscription, priceIds);
    await db.from('commerces').update(updates).eq('id', commerce.id);

    return c.json({
      data: {
        canceled_at_period_end: true,
        billing_current_period_end: updates.billing_current_period_end ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Impossible de programmer l'annulation.";
    console.error('[billing] cancel error:', message);
    return c.json({ error: message }, 400);
  }
});

/** POST /api/billing/reactivate — retire l'annulation programmée */
billingRoutes.post('/reactivate', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (!commerce?.stripe_subscription_id) {
    return c.json({ error: 'Aucun abonnement Stripe actif à réactiver.' }, 400);
  }

  try {
    const stripe = getStripe();
    const priceIds = loadPriceCatalog();
    const updatedSubscription = await stripe.subscriptions.update(commerce.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
    const { updates } = buildSubscriptionBillingUpdate(updatedSubscription, priceIds);
    await db.from('commerces').update(updates).eq('id', commerce.id);

    return c.json({ data: { reactivated: true } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Impossible de réactiver l'abonnement.";
    console.error('[billing] reactivate error:', message);
    return c.json({ error: message }, 400);
  }
});
