#!/usr/bin/env node
// scripts/setup-white-label-stripe.js
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-white-label-stripe.js

import Stripe from 'stripe';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const key = process.env.STRIPE_SECRET_KEY;

if (!key) {
  console.error('STRIPE_SECRET_KEY manquant');
  console.error('Exemple: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-white-label-stripe.js');
  process.exit(1);
}

const stripe = new Stripe(key);

const WHITE_LABEL_PRODUCTS = [
  {
    key: 'white_label_starter',
    name: 'White Label Starter',
    description: 'Offre revendeur white label avec 10 commerces inclus.',
    amount: 19900,
    includedCommerces: '10',
  },
  {
    key: 'white_label_pro',
    name: 'White Label Pro',
    description: 'Offre revendeur white label avec 25 commerces inclus.',
    amount: 44900,
    includedCommerces: '25',
  },
];

async function findProductByPlan(plan) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  return products.data.find((product) => product.metadata?.plan === plan) ?? null;
}

async function findMonthlyPrice(productId, amount) {
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    type: 'recurring',
    limit: 100,
  });

  return prices.data.find((price) => (
    price.currency === 'eur'
    && price.unit_amount === amount
    && price.recurring?.interval === 'month'
  )) ?? null;
}

async function upsertProductAndPrice(config) {
  let product = await findProductByPlan(config.key);

  if (!product) {
    product = await stripe.products.create({
      name: config.name,
      description: config.description,
      metadata: {
        plan: config.key,
        type: 'white_label',
        included_commerces: config.includedCommerces,
      },
    });
    console.log(`Produit créé: ${config.name} (${product.id})`);
  } else {
    console.log(`Produit existant: ${config.name} (${product.id})`);
  }

  let price = await findMonthlyPrice(product.id, config.amount);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: config.amount,
      currency: 'eur',
      recurring: { interval: 'month' },
      nickname: `${config.name} mensuel`,
      metadata: {
        plan: config.key,
        type: 'white_label',
        billing: 'monthly',
        included_commerces: config.includedCommerces,
      },
    });
    console.log(`Prix créé: ${config.name} mensuel (${price.id})`);
  } else {
    console.log(`Prix existant: ${config.name} mensuel (${price.id})`);
  }

  return {
    product_id: product.id,
    monthly_price_id: price.id,
  };
}

async function main() {
  const mode = key.startsWith('sk_live_') ? 'live' : 'test';
  console.log(`Configuration Stripe White Label (${mode})`);

  const result = {};
  for (const config of WHITE_LABEL_PRODUCTS) {
    result[config.key] = await upsertProductAndPrice(config);
  }

  const outPath = resolve(__dirname, '..', 'stripe-white-label-price-ids.json');
  writeFileSync(outPath, JSON.stringify({ mode, ...result }, null, 2));

  console.log('\nPRICE IDs White Label:');
  console.log(JSON.stringify({ mode, ...result }, null, 2));
  console.log(`\nSauvegardé dans ${outPath}`);
}

main().catch((error) => {
  console.error('Erreur Stripe:', error.message);
  process.exit(1);
});
