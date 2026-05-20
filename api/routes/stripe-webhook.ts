import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import Stripe from 'stripe';
import { createServiceClient } from '../../src/lib/supabase';
import {
  buildOneTimeAnnualBillingUpdate,
  buildSubscriptionBillingUpdate,
  getStripe,
  loadPriceIds,
  priceMatchesSlot,
  resolvePlanFromPriceId,
  resolvePriceSlot,
} from '../services/stripe-billing';

export const stripeWebhookRoutes = new Hono<ApiEnv>();

/** Retrouve commerce_id depuis une session ou subscription Stripe */
async function getCommerceIdFromMetadata(metadata: Stripe.Metadata | null): Promise<string | null> {
  return metadata?.commerce_id ?? null;
}

/** Retrouve commerce_id depuis le Stripe customer ID (prioritaire — évite un scan full auth.users) */
async function getCommerceIdFromStripeCustomer(
  db: ReturnType<typeof createServiceClient>,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await db.from('commerces').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  return data?.id ?? null;
}

/** Retrouve commerce_id depuis l'email du customer (fallback uniquement) */
async function getCommerceIdFromEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  const db = createServiceClient();
  const { data: { users } } = await db.auth.admin.listUsers({ perPage: 1000 });
  const user = (users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) return null;
  const { data: commerce } = await db.from('commerces').select('id').eq('user_id', user.id).maybeSingle();
  return commerce?.id ?? null;
}

/** POST /api/stripe-webhook */
stripeWebhookRoutes.post('/', async (c) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET manquant');
    return c.json({ error: 'Configuration webhook manquante' }, 500);
  }

  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'Signature manquante' }, 400);

  const rawBody = await c.req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] Signature invalide :', (err as Error).message);
    return c.json({ error: 'Signature invalide' }, 400);
  }

  const db = createServiceClient();
  const priceIds = loadPriceIds();
  console.log('[stripe-webhook] Event :', event.type);

  // Idempotency : ignore les événements déjà traités (retry Stripe)
  const { data: alreadyProcessed } = await db
    .from('stripe_events_processed')
    .select('event_id')
    .eq('event_id', event.id)
    .maybeSingle();

  if (alreadyProcessed) {
    console.log('[stripe-webhook] Event déjà traité, ignoré :', event.id);
    return c.json({ received: true });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const commerceId = await getCommerceIdFromMetadata(session.metadata)
          ?? await getCommerceIdFromEmail(session.customer_details?.email ?? null);

        if (!commerceId) {
          console.error('[stripe-webhook] Commerce introuvable pour session', session.id);
          break;
        }

        // Sauvegarde du customer Stripe
        if (session.customer && typeof session.customer === 'string') {
          await db.from('commerces').update({ stripe_customer_id: session.customer }).eq('id', commerceId);
        }

        if (session.metadata?.onboarding_addon === 'true') {
          await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          console.log('[stripe-webhook] → onboarding_purchased = true (addon inclus au checkout abonnement)');
        }

        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
        const purchasedPriceIds = lineItems.data
          .map((item) => item.price?.id)
          .filter((id): id is string => Boolean(id));
        const firstPriceId = purchasedPriceIds[0] ?? null;
        const selectedPlanFromMetadata = (() => {
          const plan = String(session.metadata?.selected_plan ?? '').toLowerCase();
          return (plan === 'starter' || plan === 'pro') ? plan : null;
        })();
        const matchedPlanFromLineItems = purchasedPriceIds
          .map((id) => resolvePlanFromPriceId(id, priceIds))
          .find((plan): plan is 'starter' | 'pro' => Boolean(plan)) ?? null;
        const matchedPlan = selectedPlanFromMetadata ?? matchedPlanFromLineItems;
        const planPriceId = purchasedPriceIds.find((id) => resolvePlanFromPriceId(id, priceIds)) ?? firstPriceId;
        const hasAccompagnementLineItem = purchasedPriceIds.some((id) => priceMatchesSlot(id, 'accompagnement', priceIds));

        console.log('[stripe-webhook] checkout.session.completed | commerce:', commerceId, '| prices:', purchasedPriceIds);

        if (matchedPlan) {
          const planSlot = planPriceId ? resolvePriceSlot(planPriceId, priceIds) : null;
          const planUpdate: Record<string, unknown> = {
            plan: matchedPlan,
            billing_status: session.mode === 'subscription' ? 'trialing' : 'active',
            stripe_price_id: planPriceId,
          };

          if (session.mode === 'payment' && planSlot) {
            Object.assign(planUpdate, buildOneTimeAnnualBillingUpdate(planSlot, planPriceId, session.created));
          }

          if (session.subscription && typeof session.subscription === 'string') {
            planUpdate.stripe_subscription_id = session.subscription;
            const subscription = await stripe.subscriptions.retrieve(session.subscription).catch(() => null);
            if (subscription) {
              Object.assign(planUpdate, buildSubscriptionBillingUpdate(subscription, priceIds).updates);
            }
          }

          await db.from('commerces').update(planUpdate).eq('id', commerceId);
          console.log('[stripe-webhook] → plan =', matchedPlan);
        } else if (priceMatchesSlot(firstPriceId, 'scanner', priceIds)) {
          console.log('[stripe-webhook] → scanner add-on ignored: scanners are unlimited');
        } else if (priceMatchesSlot(firstPriceId, 'sms_100', priceIds)) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 100 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 100');
        } else if (priceMatchesSlot(firstPriceId, 'sms_500', priceIds)) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 500 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 500');
        } else if (priceMatchesSlot(firstPriceId, 'sms_2000', priceIds)) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 2000 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 2000');
        } else {
          // Fallback : utilise les metadata du price
          const price = await stripe.prices.retrieve(firstPriceId ?? '').catch(() => null);
          const action = price?.metadata?.action;
          const plan = price?.metadata?.plan;
          if (plan === 'starter') {
            await db.from('commerces').update({ plan: 'starter', billing_status: session.mode === 'subscription' ? 'trialing' : 'active' }).eq('id', commerceId);
          } else if (plan === 'pro') {
            await db.from('commerces').update({ plan: 'pro', billing_status: session.mode === 'subscription' ? 'trialing' : 'active' }).eq('id', commerceId);
          } else if (action === 'onboarding_purchased') {
            await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          }
          else if (action === 'sms_credits') {
            const credits = parseInt(price?.metadata?.credits ?? '0');
            const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
            await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + credits }).eq('id', commerceId);
          }
        }

        if (hasAccompagnementLineItem) {
          await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          console.log('[stripe-webhook] → onboarding_purchased = true (line item)');
        }

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
        const commerceId = await getCommerceIdFromMetadata(sub.metadata)
          ?? await getCommerceIdFromStripeCustomer(db, customerId);
        if (!commerceId) break;

        const { updates, plan, priceId } = buildSubscriptionBillingUpdate(sub, priceIds);
        await db.from('commerces').update(updates).eq('id', commerceId);
        console.log('[stripe-webhook] subscription updated | commerce:', commerceId, '| plan:', plan ?? '(inchangé)', '| priceId:', priceId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
        const commerceId = await getCommerceIdFromMetadata(sub.metadata)
          ?? await getCommerceIdFromStripeCustomer(db, customerId);
        if (!commerceId) break;
        const { updates } = buildSubscriptionBillingUpdate(sub, priceIds);
        await db.from('commerces').update({
          ...updates,
          stripe_subscription_id: null,
          billing_status: 'canceled',
          billing_cancel_at_period_end: false,
          billing_access_ends_at: null,
        }).eq('id', commerceId);
        console.log('[stripe-webhook] subscription deleted → billing_status = canceled | commerce:', commerceId);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as Stripe.Customer | null)?.id ?? null;
        let commerceId: string | null = await getCommerceIdFromStripeCustomer(db, customerId);

        const invoiceAny = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
        if (!commerceId) {
          const sub = typeof invoiceAny.subscription === 'string' ? invoiceAny.subscription : invoiceAny.subscription?.id;
          if (sub) {
            const subscription = await stripe.subscriptions.retrieve(sub);
            commerceId = await getCommerceIdFromMetadata(subscription.metadata);
            if (commerceId) {
              await db.from('commerces').update(buildSubscriptionBillingUpdate(subscription, priceIds).updates).eq('id', commerceId);
            }
          }
        }

        if (commerceId) {
          const { data: comm } = await db.from('commerces').select('billing_status').eq('id', commerceId).maybeSingle();
          if (comm?.billing_status === 'past_due') {
            await db.from('commerces').update({ billing_status: 'active' }).eq('id', commerceId);
            console.log('[stripe-webhook] invoice.payment_succeeded → billing_status = active (était past_due) | commerce:', commerceId);
          } else {
            console.log('[stripe-webhook] invoice.payment_succeeded | commerce:', commerceId, '| statut:', comm?.billing_status);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as Stripe.Customer | null)?.id ?? null;
        let commerceId: string | null = await getCommerceIdFromStripeCustomer(db, customerId);

        const invoiceAny = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
        if (!commerceId) {
          const sub = typeof invoiceAny.subscription === 'string' ? invoiceAny.subscription : invoiceAny.subscription?.id;
          if (sub) {
            const subscription = await stripe.subscriptions.retrieve(sub);
            commerceId = await getCommerceIdFromMetadata(subscription.metadata);
            if (commerceId) {
              await db.from('commerces').update(buildSubscriptionBillingUpdate(subscription, priceIds).updates).eq('id', commerceId);
            }
          }
        }
        if (!commerceId && invoice.customer_email) {
          commerceId = await getCommerceIdFromEmail(invoice.customer_email);
        }
        if (!commerceId) break;

        await db.from('commerces').update({ billing_status: 'past_due' }).eq('id', commerceId);
        console.log('[stripe-webhook] invoice.payment_failed → billing_status = past_due | commerce:', commerceId);
        break;
      }

      default:
        console.log('[stripe-webhook] Event ignoré :', event.type);
    }
  } catch (err) {
    console.error('[stripe-webhook] Erreur traitement :', (err as Error).message);
    return c.json({ error: 'Erreur interne' }, 500);
  }

  // Marquer l'événement comme traité pour l'idempotence
  await db.from('stripe_events_processed')
    .upsert({ event_id: event.id }, { onConflict: 'event_id', ignoreDuplicates: true });

  return c.json({ received: true });
});
