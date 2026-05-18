import 'dotenv/config';
import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLAN_PRICE_SLOTS = [
  'starter_mensuel',
  'starter_annuel_once',
  'starter_annuel_mensuel',
  'pro_mensuel',
  'pro_annuel_once',
  'pro_annuel_mensuel',
];

function loadPriceIds() {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), 'stripe-price-ids.json'), 'utf8'));
  } catch {
    return {};
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const timeoutArg = args.find((arg) => arg.startsWith('--timeout-ms='));
  return {
    timeoutMs: timeoutArg ? Number(timeoutArg.split('=')[1]) || 10_000 : 10_000,
  };
}

async function main() {
  const { timeoutMs } = parseArgs();
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY est requis');

  const stripe = new Stripe(stripeKey, { timeout: timeoutMs, maxNetworkRetries: 1 });
  const priceIds = loadPriceIds();
  const expectedPrices = PLAN_PRICE_SLOTS
    .map((slot) => ({ slot, priceId: priceIds[slot] }))
    .filter((item) => item.priceId);

  const configurations = await stripe.billingPortal.configurations.list({ limit: 20 });
  const activeConfigurations = configurations.data.filter((config) => config.active);
  console.log(`[billing-portal-check] active_configurations=${activeConfigurations.length}`);

  for (const config of activeConfigurations) {
    const products = config.features?.subscription_update?.products ?? [];
    const allowedPrices = new Set(products.flatMap((product) => product.prices ?? []));
    const missing = expectedPrices.filter((item) => !allowedPrices.has(item.priceId));

    console.log([
      `[billing-portal-check] config=${config.id}`,
      `default=${config.is_default ? 'true' : 'false'}`,
      `subscription_update=${config.features?.subscription_update?.enabled ? 'enabled' : 'disabled'}`,
      `allowed_prices=${allowedPrices.size}`,
      `missing_plan_prices=${missing.length}`,
    ].join(' '));

    for (const item of missing) {
      console.log(`[billing-portal-check] missing slot=${item.slot} price=${item.priceId}`);
    }
  }

  if (!activeConfigurations.length) {
    console.log('[billing-portal-check] Aucun portail actif trouvé.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[billing-portal-check] fatal:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

