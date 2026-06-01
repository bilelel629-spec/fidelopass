#!/usr/bin/env node
// Usage:
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js --apply
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js --apply --include-sms

import Stripe from 'stripe';

const UNUSED_PRICE_IDS = [
  'price_1TMlW060FYcAjVxlpG5nCtKf',
  'price_1TMlW060FYcAjVxlhdUZ62Fn',
  'price_1TMlVz60FYcAjVxlSG7wb8dA',
  'price_1TMlVz60FYcAjVxl8VNyc7o6',
  'price_1TMlVy60FYcAjVxlsTpI09J1',
  'price_1TMlVy60FYcAjVxlfcAuf9EZ',
  'price_1TMlVy60FYcAjVxlNO6cYh4J',
  'price_1TMlVx60FYcAjVxlm2p12mJm',
  'price_1TMlVx60FYcAjVxlTlIYvWFd',
  'price_1TMlVw60FYcAjVxlVWNs7aJd',
  'price_1TMlVy60FYcAjVxl06t2Sgq1',
  'price_1TMlVu60FYcAjVxl8HONXsoV',
];

const OPTIONAL_SMS_PRICE_IDS = [
  'price_1TMlVy60FYcAjVxln9HC0DaE',
  'price_1TMlVy60FYcAjVxlRDOgzQWc',
  'price_1TMlVy60FYcAjVxlD5phFUTz',
];

const BLOCKING_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete']);

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    apply: args.has('--apply'),
    includeSms: args.has('--include-sms'),
  };
}

async function hasBlockingSubscription(stripe, priceId) {
  const subscriptions = await stripe.subscriptions.list({
    price: priceId,
    status: 'all',
    limit: 100,
  });

  return subscriptions.data.some((subscription) => BLOCKING_SUBSCRIPTION_STATUSES.has(subscription.status));
}

async function archivePrice(stripe, priceId, apply) {
  try {
    const price = await stripe.prices.retrieve(priceId);
    const productName = typeof price.product === 'string' ? price.product : price.product?.name;
    const amount = price.unit_amount ? `${price.unit_amount / 100} ${price.currency.toUpperCase()}` : 'montant inconnu';

    if (!price.active) {
      console.log(`[skip] ${priceId} déjà inactif (${amount}, product=${productName})`);
      return;
    }

    const blocked = await hasBlockingSubscription(stripe, priceId);
    if (blocked) {
      console.log(`[block] ${priceId} utilisé par au moins un abonnement actif/trial/past_due (${amount})`);
      return;
    }

    if (!apply) {
      console.log(`[dry-run] archiverait ${priceId} (${amount}, product=${productName})`);
      return;
    }

    await stripe.prices.update(priceId, { active: false });
    console.log(`[archived] ${priceId} (${amount}, product=${productName})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[error] ${priceId}: ${message}`);
  }
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  if (!key.startsWith('sk_live_')) {
    throw new Error('Ce script est volontairement réservé au live. Utiliser une clé sk_live_.');
  }

  const { apply, includeSms } = parseArgs();
  const stripe = new Stripe(key, { maxNetworkRetries: 1 });
  const priceIds = includeSms ? [...UNUSED_PRICE_IDS, ...OPTIONAL_SMS_PRICE_IDS] : UNUSED_PRICE_IDS;

  console.log(apply ? 'Archivage Stripe live...' : 'Dry-run Stripe live: aucune modification ne sera faite.');
  console.log(includeSms ? 'Les prix SMS seront inclus.' : 'Les prix SMS sont conservés. Ajouter --include-sms pour les archiver.');

  for (const priceId of priceIds) {
    await archivePrice(stripe, priceId, apply);
  }
}

main().catch((error) => {
  console.error('Erreur nettoyage Stripe:', error instanceof Error ? error.message : error);
  process.exit(1);
});
