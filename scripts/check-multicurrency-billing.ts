import assert from 'node:assert/strict';
import {
  currencyForCountry,
  loadPriceCatalog,
  normalizeBillingCountry,
  normalizeBillingCurrency,
  resolvePriceCurrency,
  resolvePriceSlot,
} from '../api/services/stripe-billing';

process.env.STRIPE_PRICE_ID_CHF_STARTER_MENSUEL = 'price_chf_starter_monthly';
process.env.STRIPE_PRICE_ID_CHF_PRO_ANNUEL_ONCE = 'price_chf_pro_yearly';

const catalog = loadPriceCatalog();

assert.equal(normalizeBillingCurrency('CHF'), 'chf');
assert.equal(normalizeBillingCurrency('usd'), 'eur');
assert.equal(normalizeBillingCountry('ch'), 'CH');
assert.equal(normalizeBillingCountry('de'), null);
assert.equal(currencyForCountry('CH'), 'chf');
assert.equal(currencyForCountry('FR'), 'eur');
assert.equal(resolvePriceSlot('price_chf_starter_monthly', catalog), 'starter_mensuel');
assert.equal(resolvePriceCurrency('price_chf_starter_monthly', catalog), 'chf');
assert.equal(resolvePriceSlot(catalog.eur.starter_mensuel, catalog), 'starter_mensuel');
assert.equal(resolvePriceCurrency(catalog.eur.starter_mensuel, catalog), 'eur');

console.log('Multicurrency billing checks passed.');
