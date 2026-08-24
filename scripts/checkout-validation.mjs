#!/usr/bin/env node

const API_BASE = (process.env.E2E_API_URL || 'https://api.fidelopass.com').replace(/\/$/, '');
const ACCESS_TOKEN = process.env.E2E_ACCESS_TOKEN || '';

if (!ACCESS_TOKEN) {
  console.error('❌ E2E_ACCESS_TOKEN manquant.');
  console.error('Exemple: E2E_ACCESS_TOKEN=... node scripts/checkout-validation.mjs');
  process.exit(1);
}

async function apiFetch(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function toEntry(label, plan, interval, entry) {
  return {
    label,
    plan,
    interval,
    currency: entry?.currency,
    available: Boolean(entry?.available),
  };
}

async function run() {
  const pricing = await apiFetch('/api/checkout/pricing-config');
  if (!pricing.response.ok) {
    console.error('❌ /api/checkout/pricing-config KO', pricing.response.status, pricing.payload);
    process.exit(1);
  }

  const data = pricing.payload?.data;
  if (!data) {
    console.error('❌ pricing-config sans data.');
    process.exit(1);
  }

  const entries = [
    toEntry('starter.monthly', 'starter', 'monthly', data?.starter?.monthly),
    toEntry('starter.annual', 'starter', 'yearly', data?.starter?.annual ?? data?.starter?.annual_once),
    toEntry('pro.monthly', 'pro', 'monthly', data?.pro?.monthly),
    toEntry('pro.annual', 'pro', 'yearly', data?.pro?.annual ?? data?.pro?.annual_once),
    toEntry('business.monthly', 'business', 'monthly', data?.business?.monthly),
    toEntry('business.annual', 'business', 'yearly', data?.business?.annual ?? data?.business?.annual_once),
  ];

  const requiredPlans = ['starter', 'pro', 'business'];
  const unusablePlans = requiredPlans.filter((plan) => !entries
    .filter((entry) => entry.label.startsWith(`${plan}.`))
    .some((entry) => entry.available));

  if (unusablePlans.length > 0) {
    console.error(`❌ Plans non exploitables dans pricing-config: ${unusablePlans.join(', ')}`);
    process.exit(1);
  }

  const validationResults = [];
  for (const entry of entries) {
    if (!entry.available || !entry.plan || !entry.interval) {
      validationResults.push({
        label: entry.label,
        status: 'SKIP',
        detail: 'Indisponible',
      });
      continue;
    }

    const baseDryRun = await apiFetch('/api/checkout/create-session', {
      method: 'POST',
      body: JSON.stringify({
        purchase: 'subscription',
        plan: entry.plan,
        interval: entry.interval,
        currency: entry.currency ?? pricing.payload?.currency ?? 'eur',
        country: (entry.currency ?? pricing.payload?.currency) === 'chf' ? 'CH' : 'FR',
        includeAccompagnement: true,
        dryRun: true,
      }),
    });

    if (!baseDryRun.response.ok) {
      validationResults.push({
        label: entry.label,
        status: 'FAIL',
        detail: baseDryRun.payload?.error || `HTTP ${baseDryRun.response.status}`,
      });
      continue;
    }

    validationResults.push({
      label: entry.label,
      status: baseDryRun.payload?.data?.activatesAccompagnement === true ? 'OK' : 'FAIL',
      detail: baseDryRun.payload?.data?.activatesAccompagnement === true
        ? 'setup offert activé'
        : 'setup offert non confirmé',
    });
  }

  const failed = validationResults.filter((row) => row.status === 'FAIL');
  console.table(validationResults);

  if (failed.length > 0) {
    console.error(`❌ Validation checkout KO: ${failed.length} cas en erreur.`);
    process.exit(1);
  }

  console.log('✅ Validation checkout dry-run OK.');
}

run().catch((error) => {
  console.error('❌ Erreur validation checkout', error);
  process.exit(1);
});
