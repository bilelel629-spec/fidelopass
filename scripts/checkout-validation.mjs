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

function toEntry(label, entry) {
  return {
    label,
    slot: entry?.slot,
    mode: entry?.mode,
    priceId: entry?.priceId,
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
    toEntry('starter.monthly', data?.starter?.monthly),
    toEntry('starter.annual_monthly', data?.starter?.annual_monthly),
    toEntry('starter.annual_once', data?.starter?.annual_once),
    toEntry('pro.monthly', data?.pro?.monthly),
    toEntry('pro.annual_monthly', data?.pro?.annual_monthly),
    toEntry('pro.annual_once', data?.pro?.annual_once),
  ];

  const starterAny = entries
    .filter((entry) => entry.label.startsWith('starter.'))
    .some((entry) => entry.available && Boolean(entry.priceId));
  const proAny = entries
    .filter((entry) => entry.label.startsWith('pro.'))
    .some((entry) => entry.available && Boolean(entry.priceId));

  if (!starterAny || !proAny) {
    console.error('❌ Starter/Pro non exploitables dans pricing-config.');
    process.exit(1);
  }

  const validationResults = [];
  for (const entry of entries) {
    if (!entry.available || !entry.priceId || !entry.slot || !entry.mode) {
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
        priceId: entry.priceId,
        priceSlot: entry.slot,
        mode: entry.mode,
        includeAccompagnement: false,
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
      status: 'OK',
      detail: 'base',
    });

    const addonDryRun = await apiFetch('/api/checkout/create-session', {
      method: 'POST',
      body: JSON.stringify({
        priceId: entry.priceId,
        priceSlot: entry.slot,
        mode: entry.mode,
        includeAccompagnement: true,
        dryRun: true,
      }),
    });

    validationResults.push({
      label: `${entry.label}+setup`,
      status: addonDryRun.response.ok ? 'OK' : 'FAIL',
      detail: addonDryRun.response.ok
        ? 'addon'
        : (addonDryRun.payload?.error || `HTTP ${addonDryRun.response.status}`),
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

