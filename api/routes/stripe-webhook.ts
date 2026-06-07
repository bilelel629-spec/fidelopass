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
import { sendActivationEmail } from '../services/activation-email';
import { sendBillingLifecycleEmail } from '../services/billing-lifecycle-email';
import { resellerPlanToCommercePlan, type ResellerPlan } from '../services/reseller';

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

async function getCommerceBillingContact(
  db: ReturnType<typeof createServiceClient>,
  commerceId: string,
  fallbackEmail?: string | null,
) {
  const { data } = await db
    .from('commerces')
    .select('nom, email, plan, plan_override')
    .eq('id', commerceId)
    .maybeSingle();

  return {
    commerceName: data?.nom ?? 'votre commerce',
    toEmail: data?.email ?? fallbackEmail ?? null,
    plan: data?.plan_override ?? data?.plan ?? null,
  };
}

function formatStripeAmount(amount: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof amount !== 'number') return null;
  const currencyCode = String(currency ?? 'eur').toUpperCase();
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currencyCode,
  }).format(amount / 100);
}

function formatStripeDate(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(timestamp * 1000));
}

function isResellerSubscriptionMetadata(metadata: Stripe.Metadata | null | undefined) {
  return metadata?.kind === 'reseller_merchant_subscription'
    && Boolean(metadata.reseller_id)
    && Boolean(metadata.reseller_merchant_id);
}

function centsFromMetadata(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function normalizeResellerSubscriptionStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'incomplete').toLowerCase();
  if (['trialing', 'active', 'past_due', 'canceled', 'cancelled', 'unpaid', 'incomplete'].includes(normalized)) {
    return normalized === 'canceled' ? 'cancelled' : normalized;
  }
  return 'incomplete';
}

async function updateResellerSubscriptionFromMetadata(
  db: ReturnType<typeof createServiceClient>,
  metadata: Stripe.Metadata,
  updates: Record<string, unknown>,
) {
  const resellerMerchantId = metadata.reseller_merchant_id;
  const merchantId = metadata.merchant_id;
  const plan = metadata.plan as ResellerPlan;
  const status = String(updates.subscription_status ?? 'active');
  const now = new Date().toISOString();

  await db.from('reseller_merchants').update({
    ...updates,
    updated_at: now,
  }).eq('id', resellerMerchantId);

  if (merchantId && ['starter', 'pro', 'premium'].includes(plan)) {
    const commerceUpdates: Record<string, unknown> = {
      plan: resellerPlanToCommercePlan(plan),
      billing_status: status === 'cancelled' ? 'canceled' : status,
      reseller_id: metadata.reseller_id,
      reseller_merchant_id: resellerMerchantId,
      reseller_payment_mode: String(metadata.payment_mode ?? 'stripe_direct'),
      reseller_price_cents: centsFromMetadata(metadata.reseller_price_cents),
      reseller_platform_fee_cents: centsFromMetadata(metadata.platform_fee_cents),
      actif: !['cancelled', 'past_due', 'unpaid'].includes(status),
      updated_at: now,
    };
    if (typeof updates.stripe_customer_id === 'string') {
      commerceUpdates.stripe_customer_id = updates.stripe_customer_id;
    }
    if (typeof updates.stripe_subscription_id === 'string') {
      commerceUpdates.stripe_subscription_id = updates.stripe_subscription_id;
    }
    await db.from('commerces').update(commerceUpdates).eq('id', merchantId);
  }
}

async function handleResellerCheckoutCompleted(
  db: ReturnType<typeof createServiceClient>,
  session: Stripe.Checkout.Session,
) {
  const metadata = session.metadata;
  if (!metadata || !isResellerSubscriptionMetadata(metadata)) return false;
  await updateResellerSubscriptionFromMetadata(db, metadata, {
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
    stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : null,
    stripe_checkout_session_id: session.id,
    subscription_status: session.subscription ? 'active' : 'incomplete',
    started_at: new Date().toISOString(),
    cancelled_at: null,
  });
  if (metadata.referral_id) {
    await Promise.all([
      db.from('reseller_referrals').update({
        reseller_merchant_id: metadata.reseller_merchant_id,
        merchant_id: metadata.merchant_id || null,
        checkout_session_id: session.id,
        status: session.subscription ? 'active' : 'paid',
        updated_at: new Date().toISOString(),
      }).eq('id', metadata.referral_id).eq('reseller_id', metadata.reseller_id),
      db.from('reseller_link_events').insert({
        reseller_id: metadata.reseller_id,
        event_type: 'checkout_completed',
        plan: metadata.plan ?? null,
        metadata: {
          referral_id: metadata.referral_id,
          reseller_merchant_id: metadata.reseller_merchant_id,
          merchant_id: metadata.merchant_id ?? null,
          checkout_session_id: session.id,
        },
      }),
    ]);
  }
  return true;
}

async function handleResellerSubscriptionEvent(
  db: ReturnType<typeof createServiceClient>,
  sub: Stripe.Subscription,
) {
  if (!isResellerSubscriptionMetadata(sub.metadata)) return false;
  const status = normalizeResellerSubscriptionStatus(sub.status);
  await updateResellerSubscriptionFromMetadata(db, sub.metadata, {
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
    stripe_subscription_id: sub.id,
    subscription_status: status,
    cancelled_at: status === 'cancelled' ? new Date().toISOString() : null,
  });
  if (sub.metadata.referral_id && status === 'active') {
    await db.from('reseller_referrals').update({
      status: 'active',
      updated_at: new Date().toISOString(),
    }).eq('id', sub.metadata.referral_id).eq('reseller_id', sub.metadata.reseller_id);
  }
  return true;
}

async function loadResellerSubscriptionFromInvoice(stripe: Stripe, invoice: Stripe.Invoice) {
  const invoiceAny = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
  const subId = typeof invoiceAny.subscription === 'string' ? invoiceAny.subscription : invoiceAny.subscription?.id;
  if (!subId) return null;
  return stripe.subscriptions.retrieve(subId).catch(() => null);
}

async function handleResellerInvoiceSucceeded(
  db: ReturnType<typeof createServiceClient>,
  stripe: Stripe,
  event: Stripe.Event,
  invoice: Stripe.Invoice,
) {
  const subscription = await loadResellerSubscriptionFromInvoice(stripe, invoice);
  if (!subscription || !isResellerSubscriptionMetadata(subscription.metadata)) return false;
  const metadata = subscription.metadata;
  await handleResellerSubscriptionEvent(db, subscription);
  const amountPaid = centsFromMetadata(invoice.amount_paid);
  const platformFee = centsFromMetadata(metadata.platform_fee_cents);
  const resellerCommission = Math.max(0, amountPaid - platformFee);
  const invoiceAny = invoice as Stripe.Invoice & {
    charge?: string | Stripe.Charge | null;
    payment_intent?: string | Stripe.PaymentIntent | null;
  };
  const paymentIntentId = typeof invoiceAny.payment_intent === 'string'
    ? invoiceAny.payment_intent
    : invoiceAny.payment_intent?.id ?? null;
  const chargeId = typeof invoiceAny.charge === 'string'
    ? invoiceAny.charge
    : invoiceAny.charge?.id ?? null;
  await db.from('reseller_transactions').upsert({
    reseller_id: metadata.reseller_id,
    merchant_id: metadata.merchant_id || null,
    reseller_merchant_id: metadata.reseller_merchant_id,
    type: 'subscription_paid',
    amount_cents: amountPaid,
    platform_fee_cents: platformFee,
    reseller_amount_cents: resellerCommission,
    currency: String(invoice.currency ?? metadata.currency ?? 'eur').toLowerCase(),
    stripe_event_id: event.id,
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: chargeId,
    stripe_invoice_id: invoice.id,
    metadata: {
      subscription_id: subscription.id,
      billing_reason: invoice.billing_reason,
      payment_mode: metadata.payment_mode ?? 'stripe_direct',
    },
  }, { onConflict: 'stripe_event_id', ignoreDuplicates: true });
  try {
    const linePeriod = invoice.lines?.data?.[0]?.period;
    const customerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer as Stripe.Customer | null)?.id ?? null;
    const { error: commissionError } = await db.from('reseller_commissions').upsert({
      reseller_id: metadata.reseller_id,
      reseller_merchant_id: metadata.reseller_merchant_id,
      merchant_id: metadata.merchant_id || null,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_invoice_id: invoice.id,
      stripe_charge_id: chargeId,
      stripe_payment_intent_id: paymentIntentId,
      stripe_event_id: event.id,
      period_start: linePeriod?.start ? new Date(linePeriod.start * 1000).toISOString() : null,
      period_end: linePeriod?.end ? new Date(linePeriod.end * 1000).toISOString() : null,
      plan: metadata.plan ?? null,
      amount_paid_cents: amountPaid,
      platform_fee_cents: platformFee,
      reseller_commission_cents: resellerCommission,
      currency: String(invoice.currency ?? metadata.currency ?? 'eur').toLowerCase(),
      status: 'pending',
      metadata: {
        subscription_id: subscription.id,
        billing_reason: invoice.billing_reason ?? null,
        payment_mode: metadata.payment_mode ?? 'stripe_direct',
      },
    }, { onConflict: 'stripe_invoice_id' });
    if (commissionError) {
      console.warn('[stripe-webhook] reseller commission upsert failed:', commissionError.message);
    }
  } catch (error) {
    console.warn('[stripe-webhook] reseller commission upsert failed:', error instanceof Error ? error.message : error);
  }
  return true;
}

async function handleResellerInvoiceFailed(
  db: ReturnType<typeof createServiceClient>,
  stripe: Stripe,
  event: Stripe.Event,
  invoice: Stripe.Invoice,
) {
  const subscription = await loadResellerSubscriptionFromInvoice(stripe, invoice);
  if (!subscription || !isResellerSubscriptionMetadata(subscription.metadata)) return false;
  const metadata = subscription.metadata;
  await updateResellerSubscriptionFromMetadata(db, metadata, {
    stripe_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null,
    stripe_subscription_id: subscription.id,
    subscription_status: 'past_due',
  });
  await db.from('reseller_transactions').upsert({
    reseller_id: metadata.reseller_id,
    merchant_id: metadata.merchant_id || null,
    reseller_merchant_id: metadata.reseller_merchant_id,
    type: 'failed_payment',
    amount_cents: centsFromMetadata(invoice.amount_due),
    platform_fee_cents: centsFromMetadata(metadata.platform_fee_cents),
    reseller_amount_cents: 0,
    currency: String(invoice.currency ?? metadata.currency ?? 'eur').toLowerCase(),
    stripe_event_id: event.id,
    stripe_invoice_id: invoice.id,
    metadata: {
      subscription_id: subscription.id,
      attempt_count: invoice.attempt_count,
    },
  }, { onConflict: 'stripe_event_id', ignoreDuplicates: true });
  return true;
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
        if (await handleResellerCheckoutCompleted(db, session)) {
          console.log('[stripe-webhook] reseller checkout completed | session:', session.id);
          break;
        }

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
          return (plan === 'starter' || plan === 'pro' || plan === 'business') ? plan : null;
        })();
        const matchedPlanFromLineItems = purchasedPriceIds
          .map((id) => resolvePlanFromPriceId(id, priceIds))
          .find((plan): plan is 'starter' | 'pro' | 'business' => Boolean(plan)) ?? null;
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
          if (matchedPlan === 'business') {
            planUpdate.onboarding_purchased = true;
          }

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

          const contact = await getCommerceBillingContact(db, commerceId, session.customer_details?.email ?? null);
          if (contact.toEmail) {
            await sendActivationEmail({
              toEmail: contact.toEmail,
              commerceName: contact.commerceName,
              plan: matchedPlan,
              billingStatus: String(planUpdate.billing_status) === 'trialing' ? 'trialing' : 'active',
            });
          }
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
          } else if (plan === 'business') {
            await db.from('commerces').update({ plan: 'business', billing_status: session.mode === 'subscription' ? 'trialing' : 'active', onboarding_purchased: true }).eq('id', commerceId);
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
        if (await handleResellerSubscriptionEvent(db, sub)) {
          console.log('[stripe-webhook] reseller subscription sync | subscription:', sub.id);
          break;
        }

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
        if (await handleResellerSubscriptionEvent(db, sub)) {
          console.log('[stripe-webhook] reseller subscription deleted | subscription:', sub.id);
          break;
        }

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
        const contact = await getCommerceBillingContact(db, commerceId);
        if (contact.toEmail) {
          await sendBillingLifecycleEmail({
            toEmail: contact.toEmail,
            commerceName: contact.commerceName,
            kind: 'subscription_canceled',
            plan: contact.plan,
          });
        }
        console.log('[stripe-webhook] subscription deleted → billing_status = canceled | commerce:', commerceId);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (await handleResellerInvoiceSucceeded(db, stripe, event, invoice)) {
          console.log('[stripe-webhook] reseller invoice paid | invoice:', invoice.id);
          break;
        }

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
          if (invoice.billing_reason !== 'subscription_create') {
            const contact = await getCommerceBillingContact(db, commerceId, invoice.customer_email ?? null);
            if (contact.toEmail) {
              const invoiceAny = invoice as Stripe.Invoice & { next_payment_attempt?: number | null };
              await sendBillingLifecycleEmail({
                toEmail: contact.toEmail,
                commerceName: contact.commerceName,
                kind: 'payment_succeeded',
                plan: contact.plan,
                amountLabel: formatStripeAmount(invoice.amount_paid, invoice.currency),
                nextBillingDate: formatStripeDate(invoiceAny.next_payment_attempt),
              });
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        if (await handleResellerInvoiceFailed(db, stripe, event, invoice)) {
          console.log('[stripe-webhook] reseller invoice failed | invoice:', invoice.id);
          break;
        }

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
        const contact = await getCommerceBillingContact(db, commerceId, invoice.customer_email ?? null);
        if (contact.toEmail) {
          await sendBillingLifecycleEmail({
            toEmail: contact.toEmail,
            commerceName: contact.commerceName,
            kind: 'payment_failed',
            plan: contact.plan,
            amountLabel: formatStripeAmount(invoice.amount_due, invoice.currency),
          });
        }
        console.log('[stripe-webhook] invoice.payment_failed → billing_status = past_due | commerce:', commerceId);
        break;
      }

      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        const resellerId = account.metadata?.reseller_id ?? null;
        const query = db.from('resellers').update({
          stripe_onboarding_completed: Boolean(account.details_submitted) && (account.requirements?.currently_due ?? []).length === 0,
          stripe_charges_enabled: Boolean(account.charges_enabled),
          stripe_payouts_enabled: Boolean(account.payouts_enabled),
          updated_at: new Date().toISOString(),
        });
        const { error } = resellerId
          ? await query.eq('id', resellerId)
          : await query.eq('stripe_connect_account_id', account.id);
        if (error) console.warn('[stripe-webhook] reseller account sync failed:', error.message);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;
        const { data: tx } = await db
          .from('reseller_transactions')
          .select('*')
          .or(`stripe_charge_id.eq.${charge.id}${paymentIntentId ? `,stripe_payment_intent_id.eq.${paymentIntentId}` : ''}`)
          .eq('type', 'subscription_paid')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (tx) {
          const refundedAmount = centsFromMetadata(charge.amount_refunded || charge.amount);
          const ratio = tx.amount_cents > 0 ? Math.min(1, refundedAmount / tx.amount_cents) : 1;
          await db.from('reseller_transactions').upsert({
            reseller_id: tx.reseller_id,
            merchant_id: tx.merchant_id,
            reseller_merchant_id: tx.reseller_merchant_id,
            type: 'refund',
            amount_cents: -refundedAmount,
            platform_fee_cents: -Math.round(centsFromMetadata(tx.platform_fee_cents) * ratio),
            reseller_amount_cents: -Math.round(centsFromMetadata(tx.reseller_amount_cents) * ratio),
            currency: tx.currency,
            stripe_event_id: event.id,
            stripe_payment_intent_id: paymentIntentId,
            stripe_charge_id: charge.id,
            metadata: { original_transaction_id: tx.id, refund_count: charge.refunds?.data?.length ?? null },
          }, { onConflict: 'stripe_event_id', ignoreDuplicates: true });
          try {
            const filters = [`stripe_charge_id.eq.${charge.id}`];
            if (paymentIntentId) filters.push(`stripe_payment_intent_id.eq.${paymentIntentId}`);
            const { error: commissionRefundError } = await db
              .from('reseller_commissions')
              .update({ status: 'refunded', updated_at: new Date().toISOString() })
              .or(filters.join(','));
            if (commissionRefundError) {
              console.warn('[stripe-webhook] reseller commission refund sync failed:', commissionRefundError.message);
            }
          } catch (error) {
            console.warn('[stripe-webhook] reseller commission refund sync failed:', error instanceof Error ? error.message : error);
          }
        }
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
