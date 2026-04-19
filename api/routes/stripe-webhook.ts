import { Hono } from 'hono';
import Stripe from 'stripe';
import { createServiceClient } from '../../src/lib/supabase';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const stripeWebhookRoutes = new Hono();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  return new Stripe(key);
}

type PlanName = 'starter' | 'pro' | null;

const LEGACY_PRICE_IDS = {
  starter_mensuel: ['price_1TLWbz7qMJeoJ4KrW4C8UFLr', 'price_1TMlVz60FYcAjVxl8VNyc7o6'],
  starter_annuel_mensuel: ['price_1TLWbz7qMJeoJ4KrUuITfZUO', 'price_1TMlVy60FYcAjVxlsTpI09J1'],
  starter_annuel_once: ['price_1TLWbz7qMJeoJ4KrpUsFIFPs', 'price_1TMlVz60FYcAjVxlSG7wb8dA'],
  pro_mensuel: ['price_1TLWc07qMJeoJ4KrbyyfYOlH', 'price_1TMlVx60FYcAjVxlm2p12mJm'],
  pro_annuel_mensuel: ['price_1TLWc07qMJeoJ4KrvqLZfE0u', 'price_1TMlVw60FYcAjVxlVWNs7aJd'],
  pro_annuel_once: ['price_1TLWc07qMJeoJ4KrP8wZXL9U', 'price_1TMlVx60FYcAjVxlTlIYvWFd'],
  accompagnement: ['price_1TLUSQ7qMJeoJ4KrYRnAjiPT', 'price_1TMlVu60FYcAjVxl8HONXsoV'],
  scanner: ['price_1TLUSR7qMJeoJ4KraAIhkZNc', 'price_1TMlVy60FYcAjVxl06t2Sgq1'],
  sms_100: ['price_1TLUSS7qMJeoJ4KrmbPWFh9V', 'price_1TMlVy60FYcAjVxln9HC0DaE'],
  sms_500: ['price_1TLUSS7qMJeoJ4KrR2wppPSv', 'price_1TMlVy60FYcAjVxlRDOgzQWc'],
  sms_2000: ['price_1TLUSS7qMJeoJ4Krtl3iQKiF', 'price_1TMlVy60FYcAjVxlD5phFUTz'],
} as const;

function loadPriceIds() {
  try {
    const raw = readFileSync(resolve(process.cwd(), 'stripe-price-ids.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function slotIds(slot: keyof typeof LEGACY_PRICE_IDS, priceIds: Record<string, string>): string[] {
  return Array.from(new Set([priceIds[slot], ...LEGACY_PRICE_IDS[slot]].filter(Boolean)));
}

function priceMatchesSlot(priceId: string | null, slot: keyof typeof LEGACY_PRICE_IDS, priceIds: Record<string, string>) {
  if (!priceId) return false;
  return slotIds(slot, priceIds).includes(priceId);
}

function resolvePlanFromPriceId(priceId: string | null, priceIds: Record<string, string>): PlanName {
  if (!priceId) return null;

  const starterIds = new Set([
    ...slotIds('starter_mensuel', priceIds),
    ...slotIds('starter_annuel_mensuel', priceIds),
    ...slotIds('starter_annuel_once', priceIds),
    priceIds.starter_annuel,
  ].filter(Boolean));

  const proIds = new Set([
    ...slotIds('pro_mensuel', priceIds),
    ...slotIds('pro_annuel_mensuel', priceIds),
    ...slotIds('pro_annuel_once', priceIds),
    priceIds.pro_annuel,
  ].filter(Boolean));

  if (starterIds.has(priceId)) return 'starter';
  if (proIds.has(priceId)) return 'pro';
  return null;
}

function normalizeBillingStatusFromSubscription(status: string | null | undefined) {
  if (!status) return 'unpaid';
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'unpaid';
}

/** Retrouve commerce_id depuis une session ou subscription Stripe */
async function getCommerceIdFromMetadata(metadata: Stripe.Metadata | null): Promise<string | null> {
  return metadata?.commerce_id ?? null;
}

/** Retrouve commerce_id depuis l'email du customer */
async function getCommerceIdFromEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  const db = createServiceClient();
  const { data: { users } } = await db.auth.admin.listUsers();
  const user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) return null;
  const { data: commerce } = await db.from('commerces').select('id').eq('user_id', user.id).single();
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
        const hasAccompagnementLineItem = purchasedPriceIds.some((id) => priceMatchesSlot(id, 'accompagnement', priceIds));

        console.log('[stripe-webhook] checkout.session.completed | commerce:', commerceId, '| prices:', purchasedPriceIds);

        if (matchedPlan) {
          await db
            .from('commerces')
            .update({
              plan: matchedPlan,
              billing_status: session.mode === 'subscription' ? 'trialing' : 'active',
            })
            .eq('id', commerceId);
          console.log('[stripe-webhook] → plan =', matchedPlan);
        } else if (priceMatchesSlot(firstPriceId, 'scanner', priceIds)) {
          await db.rpc('increment_scanners_count', { commerce_id_input: commerceId }).catch(() => {
            return db.from('commerces')
              .select('scanners_count')
              .eq('id', commerceId)
              .single()
              .then(({ data }) => db.from('commerces').update({ scanners_count: (data?.scanners_count ?? 1) + 1 }).eq('id', commerceId));
          });
          console.log('[stripe-webhook] → scanners_count + 1');
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
        const commerceId = await getCommerceIdFromMetadata(sub.metadata);
        if (!commerceId) break;

        const priceId = sub.items.data[0]?.price?.id ?? null;
        const selectedPlanFromMetadata = (() => {
          const plan = String(sub.metadata?.selected_plan ?? '').toLowerCase();
          return (plan === 'starter' || plan === 'pro') ? plan : null;
        })();
        const plan = selectedPlanFromMetadata
          ?? resolvePlanFromPriceId(priceId, priceIds)
          ?? sub.items.data[0]?.price?.metadata?.plan
          ?? null;
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

        const updates: Record<string, unknown> = {
          stripe_subscription_id: sub.id,
          billing_status: normalizeBillingStatusFromSubscription(sub.status),
          ...(trialEnd ? { trial_ends_at: trialEnd } : {}),
        };

        if (plan === 'starter' || plan === 'pro') updates.plan = plan;

        await db.from('commerces').update(updates).eq('id', commerceId);
        console.log('[stripe-webhook] subscription updated | commerce:', commerceId, '| plan:', plan ?? '(inchangé)', '| priceId:', priceId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const commerceId = await getCommerceIdFromMetadata(sub.metadata);
        if (!commerceId) break;
        await db.from('commerces').update({ stripe_subscription_id: null, billing_status: 'canceled' }).eq('id', commerceId);
        console.log('[stripe-webhook] subscription deleted → billing_status = canceled | commerce:', commerceId);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const sub = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        if (!sub) break;
        const subscription = await stripe.subscriptions.retrieve(sub);
        const commerceId = await getCommerceIdFromMetadata(subscription.metadata);
        if (commerceId) {
          console.log('[stripe-webhook] invoice.payment_succeeded | commerce:', commerceId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const sub = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        let commerceId: string | null = null;
        if (sub) {
          const subscription = await stripe.subscriptions.retrieve(sub);
          commerceId = await getCommerceIdFromMetadata(subscription.metadata);
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

  return c.json({ received: true });
});
