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
    } satisfies Record<string, string>;
  }
}

function resolveExpectedMode(priceId: string, priceIds: Record<string, string>): 'subscription' | 'payment' | null {
  const subscriptionPrices = new Set([
    priceIds.starter_mensuel,
    priceIds.starter_annuel_mensuel,
    priceIds.pro_mensuel,
    priceIds.pro_annuel_mensuel,
  ].filter(Boolean));

  const oneShotPrices = new Set([
    priceIds.starter_annuel_once,
    priceIds.pro_annuel_once,
  ].filter(Boolean));

  if (subscriptionPrices.has(priceId)) return 'subscription';
  if (oneShotPrices.has(priceId)) return 'payment';
  return null;
}

function resolveCommitmentLabel(priceId: string, priceIds: Record<string, string>) {
  if (priceId === priceIds.starter_mensuel || priceId === priceIds.pro_mensuel) {
    return 'monthly-flex';
  }
  if (priceId === priceIds.starter_annuel_mensuel || priceId === priceIds.pro_annuel_mensuel) {
    return 'annual-12m-monthly';
  }
  if (priceId === priceIds.starter_annuel_once || priceId === priceIds.pro_annuel_once) {
    return 'annual-12m-once';
  }
  return 'unknown';
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
  const planPriceIds = new Set([
    priceIds.starter_mensuel,
    priceIds.starter_annuel_once,
    priceIds.starter_annuel_mensuel,
    priceIds.pro_mensuel,
    priceIds.pro_annuel_once,
    priceIds.pro_annuel_mensuel,
  ].filter(Boolean));

  const isPlanCheckout = planPriceIds.has(priceId);
  const isAccompagnementOnly = priceId === priceIds.accompagnement;
  const expectedMode = resolveExpectedMode(priceId, priceIds);

  if (isAccompagnementOnly) {
    return c.json({ error: "L'option Accompagnement Setup est disponible uniquement en complément d'un pack Starter ou Pro." }, 400);
  }

  if (!isPlanCheckout || !expectedMode) {
    return c.json({ error: 'Ce plan abonnement est invalide.' }, 400);
  }

  if (mode !== expectedMode) {
    return c.json({
      error: expectedMode === 'payment'
        ? 'Ce plan annuel doit être payé en une fois.'
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

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

  const lineItems = [{ price: priceId, quantity: 1 }];
  if (includeAccompagnement && priceIds.accompagnement) {
    lineItems.push({ price: priceIds.accompagnement, quantity: 1 });
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode,
    line_items: lineItems,
    success_url: `${PUBLIC_SITE_URL}/onboarding?paid=1`,
    cancel_url: `${PUBLIC_SITE_URL}/abonnement/choix?cancelled=1`,
    locale: 'fr',
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    metadata: {
      commerce_id: commerce.id,
      user_id: userId,
      base_price_id: priceId,
      onboarding_addon: includeAccompagnement ? 'true' : 'false',
      billing_commitment: resolveCommitmentLabel(priceId, priceIds),
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
        base_price_id: priceId,
        onboarding_addon: includeAccompagnement ? 'true' : 'false',
        billing_commitment: resolveCommitmentLabel(priceId, priceIds),
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

  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id')
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
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${PUBLIC_SITE_URL}/dashboard/parametres?tab=plans`,
    });
    return c.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible d’ouvrir l’espace de gestion Stripe.';
    console.error('[checkout] create-portal-session error:', message);
    return c.json({ error: message }, 400);
  }
});
