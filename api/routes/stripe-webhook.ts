import { Hono } from 'hono';
import Stripe from 'stripe';
import { createServiceClient } from '../../src/lib/supabase';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendActivationEmail } from '../services/activation-email';
import { sendSetupAssistanceEmail } from '../services/setup-assistance-email';

export const stripeWebhookRoutes = new Hono();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  return new Stripe(key);
}

type PlanName = 'starter' | 'pro' | null;
type WhiteLabelPlan = 'white_label_starter' | 'white_label_pro';

const WHITE_LABEL_PLAN_CONFIG: Record<WhiteLabelPlan, {
  included_commerces: number;
  monthly_price_cents: number;
}> = {
  white_label_starter: {
    included_commerces: 10,
    monthly_price_cents: 19900,
  },
  white_label_pro: {
    included_commerces: 25,
    monthly_price_cents: 44900,
  },
};

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

function resolvePriceSlot(priceId: string, priceIds: Record<string, string>): keyof typeof LEGACY_PRICE_IDS | null {
  for (const slot of Object.keys(LEGACY_PRICE_IDS) as Array<keyof typeof LEGACY_PRICE_IDS>) {
    if (priceMatchesSlot(priceId, slot, priceIds)) return slot;
  }
  return null;
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

function isAnnualOnceSlot(slot: string | null | undefined) {
  return slot === 'starter_annuel_once' || slot === 'pro_annuel_once';
}

function normalizeBillingStatusFromSubscription(status: string | null | undefined) {
  if (!status) return 'unpaid';
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'unpaid';
}

function normalizeWhiteLabelPlan(value: string | null | undefined): WhiteLabelPlan | null {
  return value === 'white_label_starter' || value === 'white_label_pro' ? value : null;
}

function isWhiteLabelCheckout(metadata: Stripe.Metadata | null | undefined) {
  return metadata?.checkout_type === 'white_label_partner';
}

function slugifyPartnerName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'partenaire';
}

async function findPartnerIdForUser(db: ReturnType<typeof createServiceClient>, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('partner_users')
    .select('partner_id')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.warn('[stripe-webhook] partner lookup failed:', error.message);
    return null;
  }

  return (((data as Array<{ partner_id?: string }> | null) ?? [])[0]?.partner_id ?? null);
}

async function ensureWhiteLabelPartnerFromCheckout(
  db: ReturnType<typeof createServiceClient>,
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription | null,
) {
  const userId = String(session.metadata?.user_id ?? '').trim();
  const plan = normalizeWhiteLabelPlan(session.metadata?.partner_plan);
  if (!userId || !plan) {
    console.error('[stripe-webhook] White label metadata incomplète', { session: session.id, userId, plan });
    return;
  }

  const config = WHITE_LABEL_PLAN_CONFIG[plan];
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
  const subscriptionId = subscription?.id
    ?? (typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null);
  const billingStatus = subscription
    ? normalizeBillingStatusFromSubscription(subscription.status)
    : session.payment_status === 'paid'
      ? 'active'
      : 'unpaid';
  const trialEndsAt = subscription?.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
  const email = session.customer_details?.email ?? null;
  const baseName = session.customer_details?.name
    || email?.split('@')[0]
    || 'Partenaire Fidelopass';
  const requestedPartnerId = String(session.metadata?.partner_id ?? '').trim();
  const existingPartnerId = requestedPartnerId || await findPartnerIdForUser(db, userId);

  const updates = {
    name: baseName,
    plan,
    included_commerces: config.included_commerces,
    monthly_price_cents: config.monthly_price_cents,
    support_email: email,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    billing_status: billingStatus,
    trial_ends_at: trialEndsAt,
    active: ['trialing', 'active'].includes(billingStatus),
    white_label_enabled: true,
    hide_fidelopass_branding: true,
  };

  let partnerId = existingPartnerId;
  if (partnerId) {
    const { error } = await db
      .from('partners')
      .update(updates)
      .eq('id', partnerId);
    if (error) throw error;
  } else {
    const slug = `${slugifyPartnerName(baseName)}-${userId.slice(0, 8)}`;
    const { data, error } = await db
      .from('partners')
      .insert({
        ...updates,
        slug,
      })
      .select('id')
      .single();
    if (error) throw error;
    partnerId = data.id;
  }

  const { error: userError } = await db
    .from('partner_users')
    .upsert({
      partner_id: partnerId,
      user_id: userId,
      role: 'owner',
      active: true,
    }, { onConflict: 'partner_id,user_id' });
  if (userError) throw userError;

  console.log('[stripe-webhook] white label partner synced:', partnerId, plan, billingStatus);
}

async function updateWhiteLabelPartnerSubscription(
  db: ReturnType<typeof createServiceClient>,
  sub: Stripe.Subscription,
) {
  const plan = normalizeWhiteLabelPlan(sub.metadata?.partner_plan);
  const partnerId = String(sub.metadata?.partner_id ?? '').trim()
    || await findPartnerIdForUser(db, String(sub.metadata?.user_id ?? '').trim());
  if (!partnerId) return false;

  const billingStatus = normalizeBillingStatusFromSubscription(sub.status);
  const updates: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    billing_status: billingStatus,
    active: ['trialing', 'active'].includes(billingStatus),
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
  };

  if (plan) {
    updates.plan = plan;
    updates.included_commerces = WHITE_LABEL_PLAN_CONFIG[plan].included_commerces;
    updates.monthly_price_cents = WHITE_LABEL_PLAN_CONFIG[plan].monthly_price_cents;
  }

  const { error } = await db
    .from('partners')
    .update(updates)
    .eq('id', partnerId);
  if (error) throw error;
  console.log('[stripe-webhook] white label subscription synced:', partnerId, sub.status);
  return true;
}

/** Retrouve commerce_id depuis une session ou subscription Stripe */
async function getCommerceIdFromMetadata(metadata: Stripe.Metadata | null): Promise<string | null> {
  return metadata?.commerce_id ?? null;
}

/** Retrouve commerce_id depuis l'email du customer */
async function getCommerceIdFromEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  const db = createServiceClient();
  let page = 1;
  let user: { id: string; email?: string | null } | null = null;

  while (true) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
    if (user) break;
    if (data.users.length < 1000) break;
    page += 1;
  }

  if (!user?.id) return null;
  const { data: commerce } = await db.from('commerces').select('id').eq('user_id', user.id).single();
  return commerce?.id ?? null;
}

async function claimWebhookEvent(db: ReturnType<typeof createServiceClient>, event: Stripe.Event) {
  const { data: existing } = await db
    .from('stripe_webhook_events')
    .select('event_id, status')
    .eq('event_id', event.id)
    .maybeSingle();

  if (existing?.status === 'processed') return { shouldSkip: true };

  if (existing) {
    await db
      .from('stripe_webhook_events')
      .update({
        event_type: event.type,
        status: 'processing',
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('event_id', event.id);
    return { shouldSkip: false };
  }

  const { error: insertError } = await db.from('stripe_webhook_events').insert({
    event_id: event.id,
    event_type: event.type,
    status: 'processing',
  });

  if (!insertError) return { shouldSkip: false };

  if (insertError.code === '23505') {
    const { data: duplicate } = await db
      .from('stripe_webhook_events')
      .select('status')
      .eq('event_id', event.id)
      .maybeSingle();
    return { shouldSkip: duplicate?.status === 'processed' };
  }

  if (insertError.code === '42P01') {
    console.warn('[stripe-webhook] Table stripe_webhook_events absente, idempotence désactivée');
    return { shouldSkip: false };
  }

  throw insertError;
}

async function markWebhookEventProcessed(db: ReturnType<typeof createServiceClient>, event: Stripe.Event) {
  const { error } = await db
    .from('stripe_webhook_events')
    .update({
      status: 'processed',
      processed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('event_id', event.id);

  if (error && error.code !== '42P01') throw error;
}

async function markWebhookEventFailed(db: ReturnType<typeof createServiceClient>, event: Stripe.Event, error: string) {
  const { error: updateError } = await db
    .from('stripe_webhook_events')
    .update({
      status: 'failed',
      last_error: error.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('event_id', event.id);

  if (updateError && updateError.code !== '42P01') throw updateError;
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
    const claim = await claimWebhookEvent(db, event);
    if (claim.shouldSkip) {
      console.log('[stripe-webhook] Event déjà traité, ignoré :', event.id);
      return c.json({ received: true, duplicate: true });
    }

    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        if (isWhiteLabelCheckout(session.metadata)) {
          const subscriptionId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id ?? null;
          const subscription = subscriptionId
            ? await stripe.subscriptions.retrieve(subscriptionId)
            : null;
          await ensureWhiteLabelPartnerFromCheckout(db, session, subscription);
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

        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
        const purchasedPriceIds = lineItems.data
          .map((item) => item.price?.id)
          .filter((id): id is string => Boolean(id));
        const firstPriceId = purchasedPriceIds[0] ?? null;
        const slotFromMetadataRaw = String(session.metadata?.selected_price_slot ?? '').trim();
        const selectedSlotFromMetadata = (slotFromMetadataRaw.length > 0 ? slotFromMetadataRaw : null);
        const matchedSlotFromLineItems = purchasedPriceIds
          .map((id) => resolvePriceSlot(id, priceIds))
          .find((slot): slot is keyof typeof LEGACY_PRICE_IDS => Boolean(slot)) ?? null;
        const selectedBillingSlot = selectedSlotFromMetadata ?? matchedSlotFromLineItems;
        const annualOnceEndsAt = isAnnualOnceSlot(selectedBillingSlot)
          ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          : null;
        const selectedPlanFromMetadata = (() => {
          const plan = String(session.metadata?.selected_plan ?? '').toLowerCase();
          return (plan === 'starter' || plan === 'pro') ? plan : null;
        })();
        const matchedPlanFromLineItems = purchasedPriceIds
          .map((id) => resolvePlanFromPriceId(id, priceIds))
          .find((plan): plan is 'starter' | 'pro' => Boolean(plan)) ?? null;
        const matchedPlan = selectedPlanFromMetadata ?? matchedPlanFromLineItems;
        const hasAccompagnementLineItem = purchasedPriceIds.some((id) => priceMatchesSlot(id, 'accompagnement', priceIds));
        let activationPlanForEmail: 'starter' | 'pro' | null = null;
        let activationBillingStatusForEmail: 'trialing' | 'active' | null = null;
        let shouldSendSetupAssistanceEmail = false;

        if (session.metadata?.onboarding_addon === 'true') {
          await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          shouldSendSetupAssistanceEmail = true;
          console.log('[stripe-webhook] → onboarding_purchased = true (addon inclus au checkout abonnement)');
        }

        console.log('[stripe-webhook] checkout.session.completed | commerce:', commerceId, '| prices:', purchasedPriceIds);

        if (matchedPlan) {
          const billingStatus = session.mode === 'subscription'
            ? 'trialing'
            : (annualOnceEndsAt ? 'trialing' : 'active');
          await db
            .from('commerces')
            .update({
              plan: matchedPlan,
              billing_status: billingStatus,
              trial_ends_at: annualOnceEndsAt,
            })
            .eq('id', commerceId);
          console.log('[stripe-webhook] → plan =', matchedPlan);
          activationPlanForEmail = matchedPlan;
          activationBillingStatusForEmail = billingStatus;
        } else if (priceMatchesSlot(firstPriceId, 'scanner', priceIds)) {
          const rpcResult = await db.rpc('increment_scanners_count', { commerce_id_input: commerceId });
          if (rpcResult.error) {
            const { data } = await db.from('commerces').select('scanners_count').eq('id', commerceId).single();
            await db
              .from('commerces')
              .update({ scanners_count: (data?.scanners_count ?? 0) + 1 })
              .eq('id', commerceId);
          }
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
            const billingStatus = session.mode === 'subscription' ? 'trialing' : 'active';
            await db.from('commerces').update({ plan: 'starter', billing_status: billingStatus }).eq('id', commerceId);
            activationPlanForEmail = 'starter';
            activationBillingStatusForEmail = billingStatus;
          } else if (plan === 'pro') {
            const billingStatus = session.mode === 'subscription' ? 'trialing' : 'active';
            await db.from('commerces').update({ plan: 'pro', billing_status: billingStatus }).eq('id', commerceId);
            activationPlanForEmail = 'pro';
            activationBillingStatusForEmail = billingStatus;
          } else if (action === 'onboarding_purchased') {
            await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
            shouldSendSetupAssistanceEmail = true;
          }
          else if (action === 'sms_credits') {
            const credits = parseInt(price?.metadata?.credits ?? '0');
            const { data } = await db.from('commerces').select('sms_credits').eq('id', commerceId).single();
            await db.from('commerces').update({ sms_credits: (data?.sms_credits ?? 0) + credits }).eq('id', commerceId);
          }
        }

        if (hasAccompagnementLineItem) {
          await db.from('commerces').update({ onboarding_purchased: true }).eq('id', commerceId);
          shouldSendSetupAssistanceEmail = true;
          console.log('[stripe-webhook] → onboarding_purchased = true (line item)');
        }

        if (activationPlanForEmail && activationBillingStatusForEmail) {
          try {
            const { data: commerceRow } = await db
              .from('commerces')
              .select('nom, email')
              .eq('id', commerceId)
              .single();
            const recipientEmail = session.customer_details?.email ?? commerceRow?.email ?? null;
            if (recipientEmail) {
              const result = await sendActivationEmail({
                toEmail: recipientEmail,
                commerceName: commerceRow?.nom ?? 'Votre commerce',
                plan: activationPlanForEmail,
                billingStatus: activationBillingStatusForEmail,
              });
              console.log('[stripe-webhook] activation-email:', result.ok ? 'sent' : `not-sent:${result.reason}`);
            } else {
              console.warn('[stripe-webhook] activation-email skipped: recipient email missing');
            }
          } catch (mailError) {
            console.error('[stripe-webhook] activation-email error:', (mailError as Error).message);
          }
        }

        if (shouldSendSetupAssistanceEmail) {
          try {
            const { data: commerceRow } = await db
              .from('commerces')
              .select('nom, email')
              .eq('id', commerceId)
              .single();
            const recipientEmail = session.customer_details?.email ?? commerceRow?.email ?? null;
            if (recipientEmail) {
              const result = await sendSetupAssistanceEmail({
                toEmail: recipientEmail,
                commerceName: commerceRow?.nom ?? 'Votre commerce',
              });
              console.log('[stripe-webhook] setup-assistance-email:', result.ok ? 'sent' : `not-sent:${result.reason}`);
            } else {
              console.warn('[stripe-webhook] setup-assistance-email skipped: recipient email missing');
            }
          } catch (mailError) {
            console.error('[stripe-webhook] setup-assistance-email error:', (mailError as Error).message);
          }
        }

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;

        if (isWhiteLabelCheckout(sub.metadata)) {
          await updateWhiteLabelPartnerSubscription(db, sub);
          break;
        }

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
          trial_ends_at: trialEnd,
        };

        if (plan === 'starter' || plan === 'pro') updates.plan = plan;

        await db.from('commerces').update(updates).eq('id', commerceId);
        console.log('[stripe-webhook] subscription updated | commerce:', commerceId, '| plan:', plan ?? '(inchangé)', '| priceId:', priceId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        if (isWhiteLabelCheckout(sub.metadata)) {
          const partnerId = String(sub.metadata?.partner_id ?? '').trim()
            || await findPartnerIdForUser(db, String(sub.metadata?.user_id ?? '').trim());
          if (partnerId) {
            await db
              .from('partners')
              .update({
                stripe_subscription_id: null,
                billing_status: 'canceled',
                active: false,
                trial_ends_at: null,
              })
              .eq('id', partnerId);
            console.log('[stripe-webhook] white label subscription deleted:', partnerId);
          }
          break;
        }

        const commerceId = await getCommerceIdFromMetadata(sub.metadata);
        if (!commerceId) break;
        await db.from('commerces').update({ stripe_subscription_id: null, billing_status: 'canceled', trial_ends_at: null }).eq('id', commerceId);
        console.log('[stripe-webhook] subscription deleted → billing_status = canceled | commerce:', commerceId);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionValue = (invoice as any).subscription;
        const sub = typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id;
        if (!sub) break;
        const subscription = await stripe.subscriptions.retrieve(sub);
        if (isWhiteLabelCheckout(subscription.metadata)) {
          await updateWhiteLabelPartnerSubscription(db, subscription);
          break;
        }

        const commerceId = await getCommerceIdFromMetadata(subscription.metadata);
        if (commerceId) {
          await db.from('commerces').update({ billing_status: 'active' }).eq('id', commerceId);
          console.log('[stripe-webhook] invoice.payment_succeeded | commerce:', commerceId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionValue = (invoice as any).subscription;
        const sub = typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id;
        let commerceId: string | null = null;
        if (sub) {
          const subscription = await stripe.subscriptions.retrieve(sub);
          if (isWhiteLabelCheckout(subscription.metadata)) {
            const partnerId = String(subscription.metadata?.partner_id ?? '').trim()
              || await findPartnerIdForUser(db, String(subscription.metadata?.user_id ?? '').trim());
            if (partnerId) {
              await db.from('partners').update({ billing_status: 'past_due', active: false }).eq('id', partnerId);
              console.log('[stripe-webhook] white label invoice.payment_failed:', partnerId);
            }
            break;
          }
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

    await markWebhookEventProcessed(db, event);
  } catch (err) {
    const message = (err as Error).message;
    await markWebhookEventFailed(db, event, message).catch(() => undefined);
    console.error('[stripe-webhook] Erreur traitement :', message);
    return c.json({ error: 'Erreur interne' }, 500);
  }

  return c.json({ received: true });
});
