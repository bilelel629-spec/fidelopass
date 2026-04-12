import { Hono } from 'hono';
import Stripe from 'stripe';
import { createServiceClient } from '../../src/lib/supabase';

export const stripeWebhookRoutes = new Hono();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  return new Stripe(key);
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

        const priceId = session.line_items?.data?.[0]?.price?.id ?? null;
        console.log('[stripe-webhook] checkout.session.completed | commerce:', commerceId, '| price:', priceId);

        // Détection du produit via les IDs de prix enregistrés
        let priceIds: Record<string, string> = {};
        try {
          const { readFileSync } = await import('fs');
          const { resolve } = await import('path');
          const raw = readFileSync(resolve(process.cwd(), 'stripe-price-ids.json'), 'utf8');
          priceIds = JSON.parse(raw);
        } catch {
          console.warn('[stripe-webhook] stripe-price-ids.json non trouvé, utilisation des metadata');
        }

        if (priceId === priceIds.starter_mensuel || priceId === priceIds.starter_annuel) {
          await db.from('commerces').update({ plan: 'starter' }).eq('id', commerceId);
          console.log('[stripe-webhook] → plan = starter');
        } else if (priceId === priceIds.pro_mensuel || priceId === priceIds.pro_annuel) {
          await db.from('commerces').update({ plan: 'pro' }).eq('id', commerceId);
          console.log('[stripe-webhook] → plan = pro');
        } else if (priceId === priceIds.accompagnement) {
          await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          console.log('[stripe-webhook] → onboarding_purchased = true');
        } else if (priceId === priceIds.scanner) {
          await db.rpc('increment_scanners_count', { commerce_id_input: commerceId }).catch(() => {
            return db.from('commerces')
              .select('scanners_count')
              .eq('id', commerceId)
              .single()
              .then(({ data }) => db.from('commerces').update({ scanners_count: (data?.scanners_count ?? 1) + 1 }).eq('id', commerceId));
          });
          console.log('[stripe-webhook] → scanners_count + 1');
        } else if (priceId === priceIds.sms_100) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 100 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 100');
        } else if (priceId === priceIds.sms_500) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 500 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 500');
        } else if (priceId === priceIds.sms_2000) {
          const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
          await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + 2000 }).eq('id', commerceId);
          console.log('[stripe-webhook] → sms_credits + 2000');
        } else {
          // Fallback : utilise les metadata du price
          const price = await stripe.prices.retrieve(priceId ?? '').catch(() => null);
          const action = price?.metadata?.action;
          const plan = price?.metadata?.plan;
          if (plan === 'starter') await db.from('commerces').update({ plan: 'starter' }).eq('id', commerceId);
          else if (plan === 'pro') await db.from('commerces').update({ plan: 'pro' }).eq('id', commerceId);
          else if (action === 'onboarding_purchased') await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          else if (action === 'sms_credits') {
            const credits = parseInt(price?.metadata?.credits ?? '0');
            const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
            await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + credits }).eq('id', commerceId);
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const commerceId = await getCommerceIdFromMetadata(sub.metadata);
        if (!commerceId) break;

        const priceId = sub.items.data[0]?.price?.id ?? null;
        const plan = sub.items.data[0]?.price?.metadata?.plan;
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

        const updates: Record<string, unknown> = {
          stripe_subscription_id: sub.id,
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
        await db.from('commerces').update({ plan: 'starter', stripe_subscription_id: null }).eq('id', commerceId);
        console.log('[stripe-webhook] subscription deleted → plan = starter | commerce:', commerceId);
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

        await db.from('commerces').update({ plan: 'starter' }).eq('id', commerceId);
        console.log('[stripe-webhook] invoice.payment_failed → plan = starter | commerce:', commerceId);
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
