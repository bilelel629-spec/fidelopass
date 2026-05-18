import 'dotenv/config';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PRICE_SLOTS = [
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

const LEGACY_PRICE_IDS = {
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

function parseArgs() {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const commerceArg = args.find((arg) => arg.startsWith('--commerce='));
  const timeoutArg = args.find((arg) => arg.startsWith('--timeout-ms='));

  return {
    write: args.includes('--write'),
    limit: limitArg ? Number(limitArg.split('=')[1]) || 50 : 50,
    commerceId: commerceArg ? commerceArg.split('=')[1] || null : null,
    timeoutMs: timeoutArg ? Number(timeoutArg.split('=')[1]) || 10_000 : 10_000,
  };
}

function loadPriceIds() {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), 'stripe-price-ids.json'), 'utf8'));
  } catch {
    return {};
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolvePriceSlot(priceId, priceIds) {
  if (!priceId) return null;
  for (const slot of PRICE_SLOTS) {
    const candidates = unique([priceIds[slot], ...(LEGACY_PRICE_IDS[slot] ?? [])]);
    if (candidates.includes(priceId)) return slot;
  }
  return null;
}

function resolvePlanFromSlot(slot) {
  if (!slot) return null;
  if (slot.startsWith('starter_')) return 'starter';
  if (slot.startsWith('pro_')) return 'pro';
  return null;
}

function resolveCommitmentLabelFromSlot(slot) {
  if (slot === 'starter_mensuel' || slot === 'pro_mensuel') return 'monthly-flex';
  if (slot === 'starter_annuel_mensuel' || slot === 'pro_annuel_mensuel') return 'annual-12m-monthly';
  if (slot === 'starter_annuel_once' || slot === 'pro_annuel_once') return 'annual-12m-once';
  return 'unknown';
}

function resolveBillingIntervalFromSlot(slot) {
  if (slot === 'starter_mensuel' || slot === 'pro_mensuel') return 'month';
  if (slot === 'starter_annuel_mensuel' || slot === 'pro_annuel_mensuel') return 'month';
  if (slot === 'starter_annuel_once' || slot === 'pro_annuel_once') return 'one_time';
  return null;
}

function toIsoFromSeconds(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function normalizeBillingStatus(status) {
  return ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'].includes(status)
    ? status
    : 'unpaid';
}

function getSubscriptionPeriodEnd(subscription) {
  const item = subscription.items?.data?.[0];
  return toIsoFromSeconds(subscription.current_period_end ?? item?.current_period_end ?? null);
}

function buildSubscriptionBillingUpdate(subscription, priceIds) {
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const slot = resolvePriceSlot(priceId, priceIds);
  const metadataPlan = String(subscription.metadata?.selected_plan ?? '').toLowerCase();
  const plan = ['starter', 'pro'].includes(metadataPlan) ? metadataPlan : resolvePlanFromSlot(slot);
  const commitment = String(subscription.metadata?.billing_commitment ?? '') || (slot ? resolveCommitmentLabelFromSlot(slot) : 'unknown');
  const periodEnd = getSubscriptionPeriodEnd(subscription);
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  const updates = {
    stripe_subscription_id: subscription.id,
    billing_status: normalizeBillingStatus(subscription.status),
    stripe_price_id: priceId,
    billing_interval: slot ? resolveBillingIntervalFromSlot(slot) : null,
    billing_commitment: commitment,
    billing_current_period_end: periodEnd,
    billing_cancel_at_period_end: cancelAtPeriodEnd,
    billing_cancel_at: toIsoFromSeconds(subscription.cancel_at),
    billing_canceled_at: toIsoFromSeconds(subscription.canceled_at),
    billing_access_ends_at: cancelAtPeriodEnd ? periodEnd : null,
  };

  if (subscription.trial_end) updates.trial_ends_at = toIsoFromSeconds(subscription.trial_end);
  if (plan) updates.plan = plan;
  if (customerId) updates.stripe_customer_id = customerId;

  return { updates, plan, priceId, commitment, periodEnd };
}

function short(value) {
  return value ? value.slice(0, 8) : 'null';
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]);
}

async function main() {
  const args = parseArgs();
  console.log(`[billing-backfill] init mode=${args.write ? 'write' : 'dry-run'} limit=${args.limit} timeout_ms=${args.timeoutMs}`);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis');
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY est requis');

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const stripe = new Stripe(stripeKey, { timeout: args.timeoutMs, maxNetworkRetries: 1 });
  const priceIds = loadPriceIds();

  let query = db
    .from('commerces')
    .select('id, stripe_subscription_id, stripe_customer_id, plan, billing_status, created_at')
    .not('stripe_subscription_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(args.limit);

  if (args.commerceId) query = query.eq('id', args.commerceId);

  const { data: commerces, error } = await withTimeout(query, args.timeoutMs, 'Supabase commerces query');
  if (error) throw error;

  console.log(`[billing-backfill] subscriptions=${commerces?.length ?? 0}`);

  for (const commerce of commerces ?? []) {
    const subscriptionId = commerce.stripe_subscription_id;
    if (!subscriptionId) continue;

    try {
      const subscription = await withTimeout(
        stripe.subscriptions.retrieve(subscriptionId),
        args.timeoutMs,
        `Stripe subscription ${short(subscriptionId)}`,
      );
      const { updates, plan, priceId, commitment, periodEnd } = buildSubscriptionBillingUpdate(subscription, priceIds);

      console.log([
        `[billing-backfill] commerce=${short(commerce.id)}`,
        `subscription=${short(subscriptionId)}`,
        `status=${subscription.status}`,
        `plan=${plan ?? commerce.plan ?? 'unknown'}`,
        `price=${priceId ?? 'unknown'}`,
        `commitment=${commitment}`,
        `period_end=${periodEnd ?? 'unknown'}`,
        `cancel_at_period_end=${subscription.cancel_at_period_end ? 'true' : 'false'}`,
      ].join(' '));

      if (args.write) {
        const { error: updateError } = await withTimeout(
          db.from('commerces').update(updates).eq('id', commerce.id),
          args.timeoutMs,
          `Supabase commerce update ${short(commerce.id)}`,
        );
        if (updateError) throw updateError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[billing-backfill] error commerce=${short(commerce.id)} subscription=${short(subscriptionId)} ${message}`);
    }
  }

  console.log(args.write
    ? '[billing-backfill] terminé: base mise à jour.'
    : '[billing-backfill] terminé: aucune écriture. Relancer avec --write pour appliquer.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[billing-backfill] fatal:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

