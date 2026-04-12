import { Hono } from 'hono';
import { z } from 'zod';
import Stripe from 'stripe';
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
});

/** POST /api/checkout/create-session */
checkoutRoutes.post('/create-session', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = createSessionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const { priceId, mode } = parsed.data;

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id, stripe_customer_id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  // Récupère l'email depuis auth.users
  const { data: { user } } = await db.auth.admin.getUserById(userId);
  const email = user?.email ?? undefined;

  const stripe = getStripe();

  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${PUBLIC_SITE_URL}/onboarding?paid=1`,
    cancel_url: `${PUBLIC_SITE_URL}/pricing?cancelled=1`,
    locale: 'fr',
    allow_promotion_codes: true,
    automatic_tax: { enabled: false },
    metadata: { commerce_id: commerce.id, user_id: userId },
    ...(email ? { customer_email: email } : {}),
    ...(commerce.stripe_customer_id ? { customer: commerce.stripe_customer_id } : {}),
  };

  if (mode === 'subscription') {
    sessionParams.subscription_data = {
      trial_period_days: 14,
      metadata: { commerce_id: commerce.id, user_id: userId },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return c.json({ url: session.url });
});
