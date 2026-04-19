import { Hono } from 'hono';
import { z } from 'zod';
import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authMiddleware } from '../middleware/auth';
import { createServiceClient } from '../../src/lib/supabase';

export const checkoutRoutes = new Hono();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  return new Stripe(key);
}

const createSessionSchema = z.object({
  priceId: z.string().min(1),
  mode: z.enum(['subscription', 'payment']),
  includeAccompagnement: z.boolean().optional().default(false),
});

type PriceSlot =
  | 'starter_mensuel'
  | 'starter_annuel_once'
  | 'starter_annuel_mensuel'
  | 'pro_mensuel'
  | 'pro_annuel_once'
  | 'pro_annuel_mensuel'
  | 'accompagnement'
  | 'scanner'
  | 'sms_100'
  | 'sms_500'
  | 'sms_2000';

const PRICE_SLOTS: PriceSlot[] = [
  'starter_mensuel',
  'starter_annuel_once',
  'starter_annuel_mensuel',
  'pro_mensuel',
  'pro_annuel_once',
  'pro_annuel_mensuel',
  'accompagnement',
  'scanner',
  'sms_100',
  'sms_500',
  'sms_2000',
];

const LEGACY_PRICE_IDS: Record<PriceSlot, string[]> = {
  starter_mensuel: ['price_1TLWbz7qMJeoJ4KrW4C8UFLr', 'price_1TMlVz60FYcAjVxl8VNyc7o6'],
  starter_annuel_once: ['price_1TLWbz7qMJeoJ4KrpUsFIFPs', 'price_1TMlVz60FYcAjVxlSG7wb8dA'],
  starter_annuel_mensuel: ['price_1TLWbz7qMJeoJ4KrUuITfZUO', 'price_1TMlVy60FYcAjVxlsTpI09J1'],
  pro_mensuel: ['price_1TLWc07qMJeoJ4KrbyyfYOlH', 'price_1TMlVx60FYcAjVxlm2p12mJm'],
  pro_annuel_once: ['price_1TLWc07qMJeoJ4KrP8wZXL9U', 'price_1TMlVx60FYcAjVxlTlIYvWFd'],
  pro_annuel_mensuel: ['price_1TLWc07qMJeoJ4KrvqLZfE0u', 'price_1TMlVw60FYcAjVxlVWNs7aJd'],
  accompagnement: ['price_1TLUSQ7qMJeoJ4KrYRnAjiPT', 'price_1TMlVu60FYcAjVxl8HONXsoV'],
  scanner: ['price_1TLUSR7qMJeoJ4KraAIhkZNc', 'price_1TMlVy60FYcAjVxl06t2Sgq1'],
  sms_100: ['price_1TLUSS7qMJeoJ4KrmbPWFh9V', 'price_1TMlVy60FYcAjVxln9HC0DaE'],
  sms_500: ['price_1TLUSS7qMJeoJ4KrR2wppPSv', 'price_1TMlVy60FYcAjVxlRDOgzQWc'],
  sms_2000: ['price_1TLUSS7qMJeoJ4Krtl3iQKiF', 'price_1TMlVy60FYcAjVxlD5phFUTz'],
};

function loadPriceIds() {
  try {
    const raw = readFileSync(resolve(process.cwd(), 'stripe-price-ids.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {
      starter_mensuel: 'price_1TMlVz60FYcAjVxl8VNyc7o6',
      starter_annuel_once: 'price_1TMlVz60FYcAjVxlSG7wb8dA',
      starter_annuel_mensuel: 'price_1TMlVy60FYcAjVxlsTpI09J1',
      pro_mensuel: 'price_1TMlVx60FYcAjVxlm2p12mJm',
      pro_annuel_once: 'price_1TMlVx60FYcAjVxlTlIYvWFd',
      pro_annuel_mensuel: 'price_1TMlVw60FYcAjVxlVWNs7aJd',
      accompagnement: 'price_1TMlVu60FYcAjVxl8HONXsoV',
      scanner: 'price_1TMlVy60FYcAjVxl06t2Sgq1',
      sms_100: 'price_1TMlVy60FYcAjVxln9HC0DaE',
      sms_500: 'price_1TMlVy60FYcAjVxlRDOgzQWc',
      sms_2000: 'price_1TMlVy60FYcAjVxlD5phFUTz',
    } satisfies Record<string, string>;
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}

function candidatesForSlot(slot: PriceSlot, priceIds: Record<string, string>): string[] {
  return unique([priceIds[slot], ...(LEGACY_PRICE_IDS[slot] ?? [])]);
}

function resolvePriceSlot(priceId: string, priceIds: Record<string, string>): PriceSlot | null {
  for (const slot of PRICE_SLOTS) {
    if (candidatesForSlot(slot, priceIds).includes(priceId)) return slot;
  }
  return null;
}

function resolveExpectedModeFromSlot(slot: PriceSlot): 'subscription' | 'payment' {
  if (
    slot === 'starter_mensuel'
    || slot === 'starter_annuel_mensuel'
    || slot === 'pro_mensuel'
    || slot === 'pro_annuel_mensuel'
  ) {
    return 'subscription';
  }
  return 'payment';
}

function resolveCommitmentLabelFromSlot(slot: PriceSlot) {
  if (slot === 'starter_mensuel' || slot === 'pro_mensuel') {
    return 'monthly-flex';
  }
  if (slot === 'starter_annuel_mensuel' || slot === 'pro_annuel_mensuel') {
    return 'annual-12m-monthly';
  }
  if (slot === 'starter_annuel_once' || slot === 'pro_annuel_once') {
    return 'annual-12m-once';
  }
  return 'unknown';
}

function resolvePlanFromSlot(slot: PriceSlot): 'starter' | 'pro' | null {
  if (slot.startsWith('starter_')) return 'starter';
  if (slot.startsWith('pro_')) return 'pro';
  return null;
}

function isNoSuchPriceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /No such price/i.test(message);
}

async function resolveUsablePriceId(
  stripe: Stripe,
  slot: PriceSlot,
  requestedPriceId: string,
  priceIds: Record<string, string>,
): Promise<string> {
  const attempts = unique([requestedPriceId, ...candidatesForSlot(slot, priceIds)]);
  for (const candidate of attempts) {
    try {
      await stripe.prices.retrieve(candidate);
      return candidate;
    } catch (error) {
      if (isNoSuchPriceError(error)) continue;
      throw error;
    }
  }
  throw new Error(`No such price: '${requestedPriceId}'`);
}

/** POST /api/checkout/create-session */
checkoutRoutes.post('/create-session', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = createSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const { priceId, mode, includeAccompagnement } = parsed.data;
  const priceIds = loadPriceIds();
  const selectedSlot = resolvePriceSlot(priceId, priceIds);

  if (!selectedSlot) {
    return c.json({ error: 'Prix Stripe invalide.' }, 400);
  }

  const expectedMode = resolveExpectedModeFromSlot(selectedSlot);
  const selectedPlan = resolvePlanFromSlot(selectedSlot);
  const isPlanCheckout = selectedPlan !== null;
  const isAccompagnementOnly = selectedSlot === 'accompagnement';

  if (isAccompagnementOnly) {
    return c.json({ error: "L'option Accompagnement Setup est disponible uniquement en complément d'un pack Starter ou Pro." }, 400);
  }

  if (mode !== expectedMode) {
    return c.json({
      error: expectedMode === 'payment'
        ? 'Cet achat doit être payé en une fois.'
        : 'Ce plan doit être payé en mode abonnement.',
    }, 400);
  }

  if (includeAccompagnement && !isPlanCheckout) {
    return c.json({ error: "L'option Accompagnement Setup ne peut être ajoutée qu'à un abonnement Starter ou Pro." }, 400);
  }

  const db = createServiceClient();
  const { data: { user } } = await db.auth.admin.getUserById(userId);
  const email = user?.email ?? undefined;

  const { data: existingCommerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id')
    .eq('user_id', userId)
    .single();

  let commerce = existingCommerce;
  if (!commerce) {
    const fallbackName = (email?.split('@')[0] ?? 'Mon commerce').trim() || 'Mon commerce';
    const { data: createdCommerce, error: createCommerceError } = await db
      .from('commerces')
      .insert({
        user_id: userId,
        nom: fallbackName,
        onboarding_completed: false,
        billing_status: 'unpaid',
      })
      .select('id, stripe_customer_id')
      .single();
    if (createCommerceError || !createdCommerce) {
      return c.json({ error: "Impossible d'initialiser le commerce avant le paiement." }, 500);
    }
    commerce = createdCommerce;
  }

  const stripe = getStripe();
  const resolvedBasePriceId = await resolveUsablePriceId(stripe, selectedSlot, priceId, priceIds);
  const resolvedAccompagnementPriceId = includeAccompagnement
    ? await resolveUsablePriceId(stripe, 'accompagnement', priceIds.accompagnement ?? LEGACY_PRICE_IDS.accompagnement[0], priceIds)
    : null;

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
  const successUrl = isPlanCheckout
    ? `${PUBLIC_SITE_URL}/onboarding?paid=1`
    : `${PUBLIC_SITE_URL}/dashboard/sms?checkout=success`;
  const cancelUrl = isPlanCheckout
    ? `${PUBLIC_SITE_URL}/abonnement/choix?cancelled=1`
    : `${PUBLIC_SITE_URL}/dashboard/sms?checkout=cancelled`;

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
    ...(email ? { customer_email: email } : {}),
    ...(commerce.stripe_customer_id ? { customer: commerce.stripe_customer_id } : {}),
  };

  if (mode === 'subscription') {
    sessionParams.subscription_data = {
      trial_period_days: 14,
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
    const returnUrl = `${PUBLIC_SITE_URL}/dashboard/parametres?tab=plans`;
    const subscriptionId = commerce.stripe_subscription_id;
    let session: Stripe.BillingPortal.Session;

    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const commitment = String(subscription.metadata?.billing_commitment ?? '').toLowerCase();
      const subscriptionPriceId = subscription.items?.data?.[0]?.price?.id ?? null;
      const subscriptionSlot = subscriptionPriceId ? resolvePriceSlot(subscriptionPriceId, priceIds) : null;

      const isAnnualCommitment = commitment === 'annual-12m-monthly'
        || subscriptionSlot === 'starter_annuel_mensuel'
        || subscriptionSlot === 'pro_annuel_mensuel';

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
