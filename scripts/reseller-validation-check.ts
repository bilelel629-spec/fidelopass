import assert from 'node:assert/strict';

process.env.PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.PUBLIC_SUPABASE_ANON_KEY ??= 'local-anon-key';

const {
  calculateResellerPricing,
  normalizeResellerPlan,
  normalizeStripeCountryCode,
  resellerPlanToCommercePlan,
} = await import('../api/services/reseller');

const setting = {
  min_price_cents: 6900,
  platform_fee_cents: 2400,
  currency: 'eur',
};

const pricing = calculateResellerPricing('pro', 8900, setting);
assert.equal(pricing.reseller_price_cents, 8900);
assert.equal(pricing.platform_fee_cents, 2400);
assert.equal(pricing.reseller_margin_cents, 6500);
assert.equal(pricing.currency, 'eur');

assert.throws(
  () => calculateResellerPricing('pro', 6800, setting),
  /Prix trop bas/,
);

assert.throws(
  () => calculateResellerPricing('starter', 1000, {
    min_price_cents: 1000,
    platform_fee_cents: 1200,
    currency: 'eur',
  }),
  /part Fidelopass/,
);

assert.equal(normalizeResellerPlan('business'), 'premium');
assert.equal(normalizeResellerPlan('premium'), 'premium');
assert.equal(resellerPlanToCommercePlan('premium'), 'business');
assert.equal(normalizeStripeCountryCode('fr'), 'FR');
assert.equal(normalizeStripeCountryCode('France'), undefined);

console.log('reseller validation checks passed');
