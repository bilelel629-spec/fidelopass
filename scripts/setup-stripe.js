#!/usr/bin/env node
// Usage:
//   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js --mode=test
//   STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe.js --mode=live
//
// Le script crée uniquement la grille canonique FideloPass. En test, il écrit
// stripe-price-ids.test.json pour éviter de mélanger des Price IDs live/test.

import Stripe from 'stripe';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLANS = [
  {
    slot: 'starter',
    productName: 'Starter Indépendant',
    description: '1 point de vente, 500 cartes actives, notifications incluses',
    monthly: { slot: 'starter_mensuel', amount: 2900, lookupKey: 'fidelopass_starter_monthly' },
    annual: { slot: 'starter_annuel_once', amount: 29500, lookupKey: 'fidelopass_starter_annual_once' },
  },
  {
    slot: 'pro',
    productName: 'Commerce Pro',
    description: '3 points de vente, 2000 cartes actives, automatisations et analytics avancés',
    monthly: { slot: 'pro_mensuel', amount: 6900, lookupKey: 'fidelopass_pro_monthly' },
    annual: { slot: 'pro_annuel_once', amount: 69900, lookupKey: 'fidelopass_pro_annual_once' },
  },
  {
    slot: 'business',
    productName: 'Business',
    description: 'Cartes actives illimitées, accompagnement setup inclus, support prioritaire',
    monthly: { slot: 'business_mensuel', amount: 19900, lookupKey: 'fidelopass_business_monthly' },
    annual: { slot: 'business_annuel_once', amount: 199000, lookupKey: 'fidelopass_business_annual_once' },
  },
];

const ADDONS = [
  {
    slot: 'accompagnement',
    productName: 'Accompagnement Setup',
    description: 'Aide à la configuration et mise en ligne de la première carte',
    amount: 9000,
    lookupKey: 'fidelopass_setup_assistance',
  },
  {
    slot: 'sms_100',
    productName: 'Pack SMS',
    description: 'Crédits SMS pour campagnes clients',
    amount: 1200,
    lookupKey: 'fidelopass_sms_100',
    metadata: { credits: '100' },
  },
  {
    slot: 'sms_500',
    productName: 'Pack SMS',
    description: 'Crédits SMS pour campagnes clients',
    amount: 4900,
    lookupKey: 'fidelopass_sms_500',
    metadata: { credits: '500' },
  },
  {
    slot: 'sms_2000',
    productName: 'Pack SMS',
    description: 'Crédits SMS pour campagnes clients',
    amount: 15900,
    lookupKey: 'fidelopass_sms_2000',
    metadata: { credits: '2000' },
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith('--mode='))?.split('=')[1];
  return {
    mode: modeArg === 'live' ? 'live' : 'test',
  };
}

function assertKeyMatchesMode(key, mode) {
  if (mode === 'live' && !key.startsWith('sk_live_')) {
    throw new Error('Mode live demandé, mais STRIPE_SECRET_KEY ne commence pas par sk_live_.');
  }
  if (mode === 'test' && !key.startsWith('sk_test_')) {
    throw new Error('Mode test demandé, mais STRIPE_SECRET_KEY ne commence pas par sk_test_.');
  }
}

async function findProduct(stripe, name) {
  const products = await stripe.products.search({
    query: `name:"${name.replace(/"/g, '\\"')}"`,
    limit: 10,
  });
  return products.data.find((product) => product.name === name && product.active) ?? null;
}

async function ensureProduct(stripe, config, metadata) {
  const existing = await findProduct(stripe, config.productName);
  if (existing) return existing;

  return stripe.products.create({
    name: config.productName,
    description: config.description,
    metadata,
  });
}

async function findPriceByLookupKey(stripe, lookupKey) {
  const prices = await stripe.prices.search({
    query: `lookup_key:"${lookupKey}" AND active:"true"`,
    limit: 10,
  });
  return prices.data[0] ?? null;
}

async function findEquivalentActivePrice(stripe, productId, config, recurring) {
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });

  return prices.data.find((price) => {
    const sameAmount = price.unit_amount === config.amount && price.currency === 'eur';
    const expectedType = recurring ? 'recurring' : 'one_time';
    const sameType = price.type === expectedType;
    const sameRecurring = !recurring || price.recurring?.interval === recurring.interval;
    return sameAmount && sameType && sameRecurring;
  }) ?? null;
}

async function ensurePrice(stripe, productId, config, metadata, recurring = null) {
  const equivalent = await findEquivalentActivePrice(stripe, productId, config, recurring);
  if (equivalent) return equivalent;

  const existing = await findPriceByLookupKey(stripe, config.lookupKey);
  if (existing) {
    const expectedType = recurring ? 'recurring' : 'one_time';
    const sameAmount = existing.unit_amount === config.amount && existing.currency === 'eur';
    const sameType = existing.type === expectedType;
    const sameRecurring = !recurring || existing.recurring?.interval === recurring.interval;
    if (sameAmount && sameType && sameRecurring) return existing;
  }

  return stripe.prices.create({
    product: productId,
    unit_amount: config.amount,
    currency: 'eur',
    ...(existing ? {} : { lookup_key: config.lookupKey }),
    nickname: config.lookupKey,
    metadata,
    ...(recurring ? { recurring } : {}),
  });
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');

  const { mode } = parseArgs();
  assertKeyMatchesMode(key, mode);

  const stripe = new Stripe(key, { maxNetworkRetries: 1 });
  const ids = {
    starter_mensuel: '',
    starter_annuel_once: '',
    starter_annuel_mensuel: '',
    pro_mensuel: '',
    pro_annuel_once: '',
    pro_annuel_mensuel: '',
    business_mensuel: '',
    business_annuel_once: '',
    business_annuel_mensuel: '',
    accompagnement: '',
    sms_100: '',
    sms_500: '',
    sms_2000: '',
  };

  console.log(`Stripe ${mode}: synchronisation de la grille canonique FideloPass.`);

  for (const plan of PLANS) {
    const product = await ensureProduct(stripe, plan, { kind: 'fidelopass_plan', plan: plan.slot });
    const monthly = await ensurePrice(
      stripe,
      product.id,
      plan.monthly,
      { kind: 'fidelopass_plan', plan: plan.slot, billing: 'monthly', slot: plan.monthly.slot },
      { interval: 'month' },
    );
    const annual = await ensurePrice(
      stripe,
      product.id,
      plan.annual,
      { kind: 'fidelopass_plan', plan: plan.slot, billing: 'annual_recurring', slot: plan.annual.slot },
      { interval: 'year' },
    );

    ids[plan.monthly.slot] = monthly.id;
    ids[plan.annual.slot] = annual.id;
    console.log(`${plan.productName}: ${monthly.id} / ${annual.id}`);
  }

  for (const addon of ADDONS) {
    const product = await ensureProduct(stripe, addon, { kind: 'fidelopass_addon' });
    const price = await ensurePrice(
      stripe,
      product.id,
      addon,
      { kind: 'fidelopass_addon', slot: addon.slot, ...(addon.metadata ?? {}) },
    );
    ids[addon.slot] = price.id;
    console.log(`${addon.productName} ${addon.slot}: ${price.id}`);
  }

  const outFile = mode === 'test' ? 'stripe-price-ids.test.json' : 'stripe-price-ids.json';
  const outPath = resolve(__dirname, '..', outFile);
  writeFileSync(outPath, `${JSON.stringify(ids, null, 2)}\n`);
  console.log(`Sauvegardé dans ${outPath}`);
}

main().catch((error) => {
  console.error('Erreur Stripe:', error instanceof Error ? error.message : error);
  process.exit(1);
});
