#!/usr/bin/env node
// scripts/setup-stripe.js
// Usage : STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js

import Stripe from 'stripe';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('❌  STRIPE_SECRET_KEY manquant');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripe = new Stripe(key);

async function create() {
  console.log('🚀  Création des produits et prix Stripe…\n');

  // ── 1. Starter Indépendant ──────────────────────────────────────────
  const starter = await stripe.products.create({
    name: 'Starter Indépendant',
    description: '1 point de vente, 500 cartes actives, push illimitées, analytics de base',
    metadata: { plan: 'starter' },
  });
  console.log('✅  Produit Starter :', starter.id);

  const starterMensuel = await stripe.prices.create({
    product: starter.id,
    unit_amount: 2900,
    currency: 'eur',
    recurring: { interval: 'month', trial_period_days: 14 },
    nickname: 'Starter mensuel',
    metadata: { plan: 'starter', billing: 'monthly' },
  });
  console.log('   Prix mensuel :', starterMensuel.id);

  const starterAnnuel = await stripe.prices.create({
    product: starter.id,
    unit_amount: 29000,
    currency: 'eur',
    recurring: { interval: 'year', trial_period_days: 14 },
    nickname: 'Starter annuel',
    metadata: { plan: 'starter', billing: 'annual' },
  });
  console.log('   Prix annuel  :', starterAnnuel.id);

  // ── 2. Commerce Pro ─────────────────────────────────────────────────
  const pro = await stripe.products.create({
    name: 'Commerce Pro',
    description: '3 points de vente, 2000 cartes actives, push ciblées, analytics avancés, campagne avis Google',
    metadata: { plan: 'pro' },
  });
  console.log('\n✅  Produit Pro :', pro.id);

  const proMensuel = await stripe.prices.create({
    product: pro.id,
    unit_amount: 5900,
    currency: 'eur',
    recurring: { interval: 'month', trial_period_days: 14 },
    nickname: 'Pro mensuel',
    metadata: { plan: 'pro', billing: 'monthly' },
  });
  console.log('   Prix mensuel :', proMensuel.id);

  const proAnnuel = await stripe.prices.create({
    product: pro.id,
    unit_amount: 59000,
    currency: 'eur',
    recurring: { interval: 'year', trial_period_days: 14 },
    nickname: 'Pro annuel',
    metadata: { plan: 'pro', billing: 'annual' },
  });
  console.log('   Prix annuel  :', proAnnuel.id);

  // ── 3. Accompagnement Setup (one-time) ──────────────────────────────
  const accompagnement = await stripe.products.create({
    name: 'Accompagnement Setup',
    description: 'Aide à la configuration, paramétrage initial et mise en ligne de votre première carte',
    metadata: { type: 'one_time', action: 'onboarding_purchased' },
  });
  const accompagnementPrice = await stripe.prices.create({
    product: accompagnement.id,
    unit_amount: 2000,
    currency: 'eur',
    nickname: 'Accompagnement Setup',
    metadata: { type: 'one_time', action: 'onboarding_purchased' },
  });
  console.log('\n✅  Accompagnement Setup :', accompagnementPrice.id);

  // ── 4. Scanner supplémentaire (one-time) ───────────────────────────
  const scanner = await stripe.products.create({
    name: 'Scanner supplémentaire',
    description: 'Accès scanner pour un point de vente additionnel',
    metadata: { type: 'one_time', action: 'scanner_add' },
  });
  const scannerPrice = await stripe.prices.create({
    product: scanner.id,
    unit_amount: 500,
    currency: 'eur',
    nickname: 'Scanner supplémentaire',
    metadata: { type: 'one_time', action: 'scanner_add' },
  });
  console.log('✅  Scanner supplémentaire :', scannerPrice.id);

  // ── 5. Pack SMS 100 ─────────────────────────────────────────────────
  const sms = await stripe.products.create({
    name: 'Pack SMS',
    description: 'Crédits SMS pour campagnes clients',
    metadata: { type: 'one_time', action: 'sms_credits' },
  });

  const sms100 = await stripe.prices.create({
    product: sms.id,
    unit_amount: 1200,
    currency: 'eur',
    nickname: 'Pack SMS 100',
    metadata: { type: 'one_time', action: 'sms_credits', credits: '100' },
  });
  console.log('\n✅  Pack SMS 100  :', sms100.id);

  const sms500 = await stripe.prices.create({
    product: sms.id,
    unit_amount: 4900,
    currency: 'eur',
    nickname: 'Pack SMS 500',
    metadata: { type: 'one_time', action: 'sms_credits', credits: '500' },
  });
  console.log('✅  Pack SMS 500  :', sms500.id);

  const sms2000 = await stripe.prices.create({
    product: sms.id,
    unit_amount: 15900,
    currency: 'eur',
    nickname: 'Pack SMS 2000',
    metadata: { type: 'one_time', action: 'sms_credits', credits: '2000' },
  });
  console.log('✅  Pack SMS 2000 :', sms2000.id);

  // ── Résumé ───────────────────────────────────────────────────────────
  const ids = {
    starter_mensuel: starterMensuel.id,
    starter_annuel:  starterAnnuel.id,
    pro_mensuel:     proMensuel.id,
    pro_annuel:      proAnnuel.id,
    accompagnement:  accompagnementPrice.id,
    scanner:         scannerPrice.id,
    sms_100:         sms100.id,
    sms_500:         sms500.id,
    sms_2000:        sms2000.id,
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PRICE IDs :');
  console.log(JSON.stringify(ids, null, 2));

  const outPath = resolve(__dirname, '..', 'stripe-price-ids.json');
  writeFileSync(outPath, JSON.stringify(ids, null, 2));
  console.log(`\n💾  Sauvegardé dans ${outPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

create().catch((err) => {
  console.error('❌  Erreur Stripe :', err.message);
  process.exit(1);
});
