import Stripe from 'stripe';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type PlanName = 'starter' | 'pro' | 'business';
export type BillingCurrency = 'eur' | 'chf';
export type BillingCountry = 'FR' | 'CH';

export type PriceSlot =
  | 'starter_mensuel'
  | 'starter_annuel_once'
  | 'starter_annuel_mensuel'
  | 'pro_mensuel'
  | 'pro_annuel_once'
  | 'pro_annuel_mensuel'
  | 'business_mensuel'
  | 'business_annuel_once'
  | 'business_annuel_mensuel'
  | 'accompagnement'
  | 'scanner'
  | 'sms_100'
  | 'sms_500'
  | 'sms_2000';

export const PRICE_SLOTS: PriceSlot[] = [
  'starter_mensuel',
  'starter_annuel_once',
  'starter_annuel_mensuel',
  'pro_mensuel',
  'pro_annuel_once',
  'pro_annuel_mensuel',
  'business_mensuel',
  'business_annuel_once',
  'business_annuel_mensuel',
  'accompagnement',
  'scanner',
  'sms_100',
  'sms_500',
  'sms_2000',
];

export const PLAN_PRICE_SLOTS: PriceSlot[] = [
  'starter_mensuel',
  'starter_annuel_once',
  'pro_mensuel',
  'pro_annuel_once',
  'business_mensuel',
  'business_annuel_once',
];

export const BILLING_CURRENCIES: BillingCurrency[] = ['eur', 'chf'];

export const PUBLIC_PRICE_AMOUNTS: Record<BillingCurrency, Partial<Record<PriceSlot, number>>> = {
  eur: {
    starter_mensuel: 2900,
    starter_annuel_once: 29500,
    pro_mensuel: 6900,
    pro_annuel_once: 69900,
    business_mensuel: 19900,
    business_annuel_once: 199000,
    accompagnement: 9000,
  },
  chf: {
    starter_mensuel: 2900,
    starter_annuel_once: 29500,
    pro_mensuel: 6900,
    pro_annuel_once: 69900,
    business_mensuel: 19900,
    business_annuel_once: 199000,
    accompagnement: 9000,
  },
};

export type StripePriceCatalog = Record<BillingCurrency, Record<PriceSlot, string>>;

export function normalizeBillingCurrency(value: unknown, fallback: BillingCurrency = 'eur'): BillingCurrency {
  return String(value ?? '').trim().toLowerCase() === 'chf' ? 'chf' : fallback;
}

export function normalizeBillingCountry(value: unknown): BillingCountry | null {
  const country = String(value ?? '').trim().toUpperCase();
  if (country === 'CH') return 'CH';
  if (country === 'FR') return 'FR';
  return null;
}

export function currencyForCountry(value: unknown): BillingCurrency {
  return normalizeBillingCountry(value) === 'CH' ? 'chf' : 'eur';
}

export function formatBillingAmount(amountCents: number, currency: BillingCurrency) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(amountCents / 100);
}

export const LEGACY_PRICE_IDS: Record<PriceSlot, string[]> = {
  starter_mensuel: ['price_1TLWbz7qMJeoJ4KrW4C8UFLr', 'price_1TMlVz60FYcAjVxl8VNyc7o6'],
  starter_annuel_once: ['price_1TLWbz7qMJeoJ4KrpUsFIFPs', 'price_1TMlVz60FYcAjVxlSG7wb8dA', 'price_1TdQrV60FYcAjVxlVDXjt4PY'],
  starter_annuel_mensuel: ['price_1TLWbz7qMJeoJ4KrUuITfZUO', 'price_1TMlVy60FYcAjVxlsTpI09J1'],
  pro_mensuel: ['price_1TLWc07qMJeoJ4KrbyyfYOlH', 'price_1TMlVx60FYcAjVxlm2p12mJm'],
  pro_annuel_once: ['price_1TLWc07qMJeoJ4KrP8wZXL9U', 'price_1TMlVx60FYcAjVxlTlIYvWFd', 'price_1TdQrY60FYcAjVxlFIxW5eRJ'],
  pro_annuel_mensuel: ['price_1TLWc07qMJeoJ4KrvqLZfE0u', 'price_1TMlVw60FYcAjVxlVWNs7aJd'],
  business_mensuel: [],
  business_annuel_once: ['price_1TdQsh60FYcAjVxlm2MTX3tg'],
  business_annuel_mensuel: [],
  accompagnement: ['price_1TLUSQ7qMJeoJ4KrYRnAjiPT', 'price_1TMlVu60FYcAjVxl8HONXsoV'],
  scanner: ['price_1TLUSR7qMJeoJ4KraAIhkZNc', 'price_1TMlVy60FYcAjVxl06t2Sgq1'],
  sms_100: ['price_1TLUSS7qMJeoJ4KrmbPWFh9V', 'price_1TMlVy60FYcAjVxln9HC0DaE'],
  sms_500: ['price_1TLUSS7qMJeoJ4KrR2wppPSv', 'price_1TMlVy60FYcAjVxlRDOgzQWc'],
  sms_2000: ['price_1TLUSS7qMJeoJ4Krtl3iQKiF', 'price_1TMlVy60FYcAjVxlD5phFUTz'],
};

export const FALLBACK_PRICE_IDS: Record<PriceSlot, string> = {
  starter_mensuel: 'price_1TdQrU60FYcAjVxlBjtioXnr',
  starter_annuel_once: 'price_1TdTej60FYcAjVxlkBzMrWwQ',
  starter_annuel_mensuel: '',
  pro_mensuel: 'price_1TdQrW60FYcAjVxlVJcylHrc',
  pro_annuel_once: 'price_1TdTek60FYcAjVxl6chYaXlD',
  pro_annuel_mensuel: '',
  business_mensuel: 'price_1TdQsf60FYcAjVxlPxRw7uBB',
  business_annuel_once: 'price_1TdTel60FYcAjVxlN56tBeCL',
  business_annuel_mensuel: '',
  accompagnement: 'price_1TdQrZ60FYcAjVxlQb01ADw1',
  scanner: 'price_1TMlVy60FYcAjVxl06t2Sgq1',
  sms_100: 'price_1TMlVy60FYcAjVxln9HC0DaE',
  sms_500: 'price_1TMlVy60FYcAjVxlRDOgzQWc',
  sms_2000: 'price_1TMlVy60FYcAjVxlD5phFUTz',
};

export function resolveStripeRuntimeMode(): 'test' | 'live' | 'unknown' {
  const stripeKey = String(process.env.STRIPE_SECRET_KEY ?? '');
  if (stripeKey.startsWith('sk_test_')) return 'test';
  if (stripeKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export function isProductionRuntime() {
  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase();
  const railwayEnv = String(process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.RAILWAY_ENVIRONMENT ?? '').toLowerCase();
  return nodeEnv === 'production' || railwayEnv === 'production';
}

export function resolveStripePriceIdsFile() {
  if (isProductionRuntime()) return 'stripe-price-ids.json';
  return resolveStripeRuntimeMode() === 'test' ? 'stripe-price-ids.test.json' : 'stripe-price-ids.json';
}

export function getPriceIdsDiagnostics(
  priceIds: Record<PriceSlot, string>,
  currency: BillingCurrency = 'eur',
) {
  const requiredSlots: PriceSlot[] = [
    'starter_mensuel',
    'starter_annuel_once',
    'pro_mensuel',
    'pro_annuel_once',
    'business_mensuel',
    'business_annuel_once',
    'accompagnement',
  ];
  return {
    stripeMode: resolveStripeRuntimeMode(),
    currency,
    priceIdsFile: resolveStripePriceIdsFile(),
    priceIdsFileFound: existsSync(resolve(process.cwd(), resolveStripePriceIdsFile())),
    missingRequiredSlots: requiredSlots.filter((slot) => !priceIds[slot]),
  };
}

export function isLegacyPriceId(slot: PriceSlot, priceId: string) {
  return LEGACY_PRICE_IDS[slot]?.includes(priceId) ?? false;
}

export function getStripe(config?: ConstructorParameters<typeof Stripe>[1]) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY manquant');
  if (isProductionRuntime() && key.startsWith('sk_test_')) {
    throw new Error('Clé Stripe test interdite en production. Configurez STRIPE_SECRET_KEY avec une clé sk_live_.');
  }
  return new Stripe(key, config);
}

type CanonicalPriceConfig = {
  productName: string;
  productDescription: string;
  amount: number;
  lookupKey: string;
  recurring?: { interval: 'month' | 'year' };
};

const STRIPE_CANONICAL_PRICE_CONFIG = {
  starter_mensuel: {
    productName: 'Starter Indépendant',
    productDescription: '1 point de vente, 500 cartes actives, notifications incluses',
    amount: 2900,
    lookupKey: 'fidelopass_starter_monthly',
    recurring: { interval: 'month' as const },
  },
  starter_annuel_once: {
    productName: 'Starter Indépendant',
    productDescription: '1 point de vente, 500 cartes actives, notifications incluses',
    amount: 29500,
    lookupKey: 'fidelopass_starter_annual_once',
    recurring: { interval: 'year' as const },
  },
  pro_mensuel: {
    productName: 'Commerce Pro',
    productDescription: '3 points de vente, 2000 cartes actives, automatisations et analytics avancés',
    amount: 6900,
    lookupKey: 'fidelopass_pro_monthly',
    recurring: { interval: 'month' as const },
  },
  pro_annuel_once: {
    productName: 'Commerce Pro',
    productDescription: '3 points de vente, 2000 cartes actives, automatisations et analytics avancés',
    amount: 69900,
    lookupKey: 'fidelopass_pro_annual_once',
    recurring: { interval: 'year' as const },
  },
  business_mensuel: {
    productName: 'Business',
    productDescription: 'Cartes actives illimitées, accompagnement setup inclus, support prioritaire',
    amount: 19900,
    lookupKey: 'fidelopass_business_monthly',
    recurring: { interval: 'month' as const },
  },
  business_annuel_once: {
    productName: 'Business',
    productDescription: 'Cartes actives illimitées, accompagnement setup inclus, support prioritaire',
    amount: 199000,
    lookupKey: 'fidelopass_business_annual_once',
    recurring: { interval: 'year' as const },
  },
  accompagnement: {
    productName: 'Accompagnement Setup',
    productDescription: 'Aide à la configuration et mise en ligne de la première carte',
    amount: 9000,
    lookupKey: 'fidelopass_setup_assistance',
  },
} satisfies Partial<Record<PriceSlot, CanonicalPriceConfig>>;

let testPriceIdsPromise: Promise<Partial<Record<PriceSlot, string>>> | null = null;

async function findCanonicalProduct(stripe: Stripe, name: string) {
  const products = await stripe.products.search({
    query: `name:"${name.replace(/"/g, '\\"')}"`,
    limit: 10,
  });
  return products.data.find((product) => product.name === name && product.active) ?? null;
}

async function ensureCanonicalProduct(
  stripe: Stripe,
  config: CanonicalPriceConfig,
) {
  const existing = await findCanonicalProduct(stripe, config.productName);
  if (existing) return existing;

  return stripe.products.create({
    name: config.productName,
    description: config.productDescription,
    metadata: { kind: 'fidelopass_auto_test_pricing' },
  });
}

async function findCanonicalPrice(stripe: Stripe, lookupKey: string) {
  const prices = await stripe.prices.search({
    query: `lookup_key:"${lookupKey}" AND active:"true"`,
    limit: 10,
  });
  return prices.data[0] ?? null;
}

function priceMatchesCanonicalConfig(
  price: Stripe.Price,
  config: CanonicalPriceConfig,
) {
  const expectedType = config.recurring ? 'recurring' : 'one_time';
  return price.active
    && price.unit_amount === config.amount
    && price.currency === 'eur'
    && price.type === expectedType
    && (!config.recurring || price.recurring?.interval === config.recurring.interval);
}

async function findEquivalentCanonicalPrice(
  stripe: Stripe,
  productId: string,
  config: CanonicalPriceConfig,
) {
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });
  return prices.data.find((price) => priceMatchesCanonicalConfig(price, config)) ?? null;
}

async function ensureCanonicalPrice(
  stripe: Stripe,
  productId: string,
  slot: PriceSlot,
  config: CanonicalPriceConfig,
) {
  const equivalent = await findEquivalentCanonicalPrice(stripe, productId, config);
  if (equivalent) return equivalent;

  const existing = await findCanonicalPrice(stripe, config.lookupKey);
  if (existing && priceMatchesCanonicalConfig(existing, config)) return existing;

  return stripe.prices.create({
    product: productId,
    unit_amount: config.amount,
    currency: 'eur',
    ...(existing ? {} : { lookup_key: config.lookupKey }),
    nickname: config.lookupKey,
    metadata: { kind: 'fidelopass_auto_test_pricing', slot },
    ...(config.recurring ? { recurring: config.recurring } : {}),
  });
}

async function createCanonicalTestPriceIds(stripe: Stripe) {
  const ids: Partial<Record<PriceSlot, string>> = {};

  for (const [slot, config] of Object.entries(STRIPE_CANONICAL_PRICE_CONFIG) as Array<[PriceSlot, CanonicalPriceConfig]>) {
    const product = await ensureCanonicalProduct(stripe, config);
    const price = await ensureCanonicalPrice(stripe, product.id, slot, config);
    ids[slot] = price.id;
  }

  return ids;
}

export async function loadRuntimePriceIds(stripe?: Stripe, currency: BillingCurrency = 'eur') {
  const priceIds = loadPriceIds(currency);
  const diagnostics = getPriceIdsDiagnostics(priceIds, currency);

  if (
    currency !== 'eur'
    ||
    diagnostics.stripeMode !== 'test'
    || isProductionRuntime()
    || diagnostics.missingRequiredSlots.length === 0
    || !stripe
  ) {
    return priceIds;
  }

  testPriceIdsPromise ??= createCanonicalTestPriceIds(stripe).catch((error) => {
    testPriceIdsPromise = null;
    throw error;
  });

  return {
    ...priceIds,
    ...(await testPriceIdsPromise),
  };
}

export function loadPriceIds(currency: BillingCurrency = 'eur') {
  const envPriceIds = Object.fromEntries(
    PRICE_SLOTS.map((slot) => {
      const key = currency === 'chf'
        ? `STRIPE_PRICE_ID_CHF_${slot.toUpperCase()}`
        : `STRIPE_PRICE_ID_${slot.toUpperCase()}`;
      return [slot, process.env[key] ?? ''];
    }),
  ) as Record<PriceSlot, string>;
  const mergeEnv = (base: Record<PriceSlot, string>) => {
    const merged = { ...base };
    PRICE_SLOTS.forEach((slot) => {
      const envValue = envPriceIds[slot];
      if (envValue && (currency === 'chf' || !isLegacyPriceId(slot, envValue))) {
        merged[slot] = envValue;
      }
    });
    return merged;
  };

  if (currency === 'chf') {
    return mergeEnv(Object.fromEntries(PRICE_SLOTS.map((slot) => [slot, ''])) as Record<PriceSlot, string>);
  }

  const priceIdsFile = resolveStripePriceIdsFile();

  try {
    const raw = readFileSync(resolve(process.cwd(), priceIdsFile), 'utf8');
    return mergeEnv({ ...FALLBACK_PRICE_IDS, ...(JSON.parse(raw) as Partial<Record<PriceSlot, string>>) });
  } catch {
    if (priceIdsFile !== 'stripe-price-ids.json') {
      return mergeEnv({
        ...FALLBACK_PRICE_IDS,
        starter_mensuel: '',
        starter_annuel_once: '',
        pro_mensuel: '',
        pro_annuel_once: '',
        business_mensuel: '',
        business_annuel_once: '',
        accompagnement: '',
        scanner: '',
        sms_100: '',
        sms_500: '',
        sms_2000: '',
      });
    }
    return mergeEnv(FALLBACK_PRICE_IDS);
  }
}

export function loadPriceCatalog(): StripePriceCatalog {
  return {
    eur: loadPriceIds('eur'),
    chf: loadPriceIds('chf'),
  };
}

export function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}

type PriceIdSource = Record<string, string> | StripePriceCatalog;

function isPriceCatalog(source: PriceIdSource): source is StripePriceCatalog {
  return typeof source.eur === 'object' && source.eur !== null
    && typeof source.chf === 'object' && source.chf !== null;
}

export function candidatesForSlot(slot: PriceSlot, priceIds: PriceIdSource): string[] {
  if (isPriceCatalog(priceIds)) {
    return unique([
      priceIds.eur[slot],
      priceIds.chf[slot],
      ...(LEGACY_PRICE_IDS[slot] ?? []),
    ]);
  }
  return unique([priceIds[slot], ...(LEGACY_PRICE_IDS[slot] ?? [])]);
}

export function resolvePriceSlot(priceId: string | null | undefined, priceIds: PriceIdSource): PriceSlot | null {
  if (!priceId) return null;
  for (const slot of PRICE_SLOTS) {
    if (candidatesForSlot(slot, priceIds).includes(priceId)) return slot;
  }
  return null;
}

export function resolvePriceCurrency(
  priceId: string | null | undefined,
  catalog: StripePriceCatalog,
): BillingCurrency | null {
  if (!priceId) return null;
  for (const currency of BILLING_CURRENCIES) {
    if (PRICE_SLOTS.some((slot) => catalog[currency][slot] === priceId)) return currency;
  }
  if (PRICE_SLOTS.some((slot) => LEGACY_PRICE_IDS[slot]?.includes(priceId))) return 'eur';
  return null;
}

export function priceMatchesSlot(priceId: string | null | undefined, slot: PriceSlot, priceIds: PriceIdSource) {
  return resolvePriceSlot(priceId, priceIds) === slot;
}

export function resolveExpectedModeFromSlot(slot: PriceSlot): 'subscription' | 'payment' {
  if (
    slot === 'starter_mensuel'
    || slot === 'starter_annuel_mensuel'
    || slot === 'pro_mensuel'
    || slot === 'pro_annuel_mensuel'
    || slot === 'business_mensuel'
    || slot === 'business_annuel_mensuel'
    || slot === 'starter_annuel_once'
    || slot === 'pro_annuel_once'
    || slot === 'business_annuel_once'
  ) {
    return 'subscription';
  }
  return 'payment';
}

export function resolveCommitmentLabelFromSlot(slot: PriceSlot) {
  if (slot === 'starter_mensuel' || slot === 'pro_mensuel' || slot === 'business_mensuel') return 'monthly-flex';
  if (slot === 'starter_annuel_mensuel' || slot === 'pro_annuel_mensuel' || slot === 'business_annuel_mensuel') return 'annual-12m-monthly';
  if (slot === 'starter_annuel_once' || slot === 'pro_annuel_once' || slot === 'business_annuel_once') return 'annual-recurring';
  return 'unknown';
}

export function resolveBillingIntervalFromSlot(slot: PriceSlot): 'month' | 'year' | 'one_time' | null {
  if (slot === 'starter_mensuel' || slot === 'pro_mensuel' || slot === 'business_mensuel') return 'month';
  if (slot === 'starter_annuel_mensuel' || slot === 'pro_annuel_mensuel' || slot === 'business_annuel_mensuel') return 'month';
  if (slot === 'starter_annuel_once' || slot === 'pro_annuel_once' || slot === 'business_annuel_once') return 'year';
  return null;
}

export function resolvePlanFromSlot(slot: PriceSlot): PlanName | null {
  if (slot.startsWith('starter_')) return 'starter';
  if (slot.startsWith('pro_')) return 'pro';
  if (slot.startsWith('business_')) return 'business';
  return null;
}

export function resolvePlanFromPriceId(priceId: string | null | undefined, priceIds: PriceIdSource): PlanName | null {
  return resolvePlanFromSlot(resolvePriceSlot(priceId, priceIds) ?? 'scanner');
}

export function toIsoFromSeconds(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

export function addOneYearIso(fromSeconds: number | null | undefined = Math.floor(Date.now() / 1000)) {
  const date = new Date((fromSeconds ?? Math.floor(Date.now() / 1000)) * 1000);
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
}

export function normalizeBillingStatusFromSubscription(status: string | null | undefined) {
  if (!status) return 'unpaid';
  if (['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'].includes(status)) {
    return status;
  }
  return 'unpaid';
}

export function isAnnualMonthlyCommitment(slot: PriceSlot | null, commitment: string | null | undefined) {
  return commitment === 'annual-12m-monthly'
    || slot === 'starter_annuel_mensuel'
    || slot === 'pro_annuel_mensuel'
    || slot === 'business_annuel_mensuel';
}

export function getCommitmentEndIso(startSeconds: number | null | undefined) {
  return addOneYearIso(startSeconds ?? Math.floor(Date.now() / 1000));
}

export function getSubscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const subAny = sub as Stripe.Subscription & { current_period_end?: number };
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  return toIsoFromSeconds(subAny.current_period_end ?? item?.current_period_end ?? null);
}

export function buildSubscriptionBillingUpdate(sub: Stripe.Subscription, priceIds: PriceIdSource) {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const priceCurrency = normalizeBillingCurrency(sub.items?.data?.[0]?.price?.currency);
  const slot = resolvePriceSlot(priceId, priceIds);
  const planFromMetadata = String(sub.metadata?.selected_plan ?? '').toLowerCase();
  const plan = planFromMetadata === 'starter' || planFromMetadata === 'pro' || planFromMetadata === 'business'
    ? planFromMetadata
    : resolvePlanFromSlot(slot ?? 'scanner');
  const commitment = String(sub.metadata?.billing_commitment ?? '') || (slot ? resolveCommitmentLabelFromSlot(slot) : 'unknown');
  const periodEnd = getSubscriptionPeriodEnd(sub);
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);

  const updates: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    billing_status: normalizeBillingStatusFromSubscription(sub.status),
    stripe_price_id: priceId,
    billing_currency: priceCurrency,
    billing_country: normalizeBillingCountry(sub.metadata?.billing_country),
    billing_currency_locked_at: new Date().toISOString(),
    billing_interval: slot ? resolveBillingIntervalFromSlot(slot) : null,
    billing_commitment: commitment,
    billing_current_period_end: periodEnd,
    billing_cancel_at_period_end: cancelAtPeriodEnd,
    billing_cancel_at: toIsoFromSeconds(sub.cancel_at),
    billing_canceled_at: toIsoFromSeconds(sub.canceled_at),
    billing_access_ends_at: cancelAtPeriodEnd ? periodEnd : null,
  };

  const trialEnd = toIsoFromSeconds(sub.trial_end);
  if (trialEnd) updates.trial_ends_at = trialEnd;
  if (plan) updates.plan = plan;

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (customerId) updates.stripe_customer_id = customerId;

  return { updates, slot, plan, priceId, commitment, periodEnd };
}

export function buildOneTimeAnnualBillingUpdate(
  slot: PriceSlot,
  priceId: string | null,
  createdSeconds?: number | null,
  currency: BillingCurrency = 'eur',
  country?: BillingCountry | null,
) {
  const plan = resolvePlanFromSlot(slot);
  return {
    plan,
    billing_status: 'active',
    stripe_price_id: priceId,
    billing_currency: currency,
    billing_country: country ?? null,
    billing_currency_locked_at: new Date().toISOString(),
    stripe_subscription_id: null,
    billing_interval: resolveBillingIntervalFromSlot(slot),
    billing_commitment: resolveCommitmentLabelFromSlot(slot),
    billing_current_period_end: addOneYearIso(createdSeconds),
    billing_cancel_at_period_end: false,
    billing_cancel_at: null,
    billing_canceled_at: null,
    billing_access_ends_at: addOneYearIso(createdSeconds),
  };
}

export function isNoSuchPriceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /No such price/i.test(message);
}

export async function resolveUsablePriceId(
  stripe: Stripe,
  slot: PriceSlot,
  requestedPriceId: string,
  priceIds: Record<string, string>,
): Promise<string> {
  const attempts = unique([requestedPriceId, ...candidatesForSlot(slot, priceIds)]);
  for (const candidate of attempts) {
    try {
      await stripe.prices.retrieve(candidate);
      return candidate;
    } catch (error) {
      if (isNoSuchPriceError(error)) continue;
      throw error;
    }
  }
  throw new Error(`No such price: '${requestedPriceId}'`);
}
