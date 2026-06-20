import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { createServiceClient } from '../../src/lib/supabase';
import { getPublicSiteUrl } from '../utils/public-site-url';

export type ResellerType = 'stripe_connect' | 'invoiced';
export type ResellerStatus = 'pending' | 'approved' | 'suspended';
export type ResellerPlan = 'starter' | 'pro' | 'premium';
export type ResellerPaymentMode = 'stripe_direct' | 'stripe_connect' | 'manual' | 'bank_transfer' | 'cash';

export type ResellerRecord = {
  id: string;
  user_id: string;
  type: ResellerType;
  status: ResellerStatus;
  country: string | null;
  currency: string;
  stripe_connect_account_id: string | null;
  stripe_onboarding_completed: boolean;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  brand_name: string;
  brand_logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  support_email: string | null;
  public_slug?: string | null;
  public_link_enabled?: boolean;
  public_signup_enabled?: boolean;
};

export type ResellerPlanSetting = {
  id: string;
  reseller_id: string;
  plan: ResellerPlan;
  min_price_cents: number;
  platform_fee_cents: number;
  currency: string;
};

export type ResellerPricing = {
  plan: ResellerPlan;
  reseller_price_cents: number;
  platform_fee_cents: number;
  reseller_margin_cents: number;
  currency: string;
};

export type ResellerPublicPlanPrice = {
  id: string;
  reseller_id: string;
  plan: ResellerPlan;
  public_price_cents: number;
  platform_fee_cents: number;
  reseller_margin_cents: number;
  currency: string;
  is_enabled: boolean;
};

const PLAN_LABELS: Record<ResellerPlan, string> = {
  starter: 'Starter',
  pro: 'Pro',
  premium: 'Premium',
};

const DEFAULT_PLAN_SETTINGS: Record<ResellerPlan, { min_price_cents: number; platform_fee_cents: number }> = {
  starter: { min_price_cents: 2900, platform_fee_cents: 1400 },
  pro: { min_price_cents: 6900, platform_fee_cents: 2400 },
  premium: { min_price_cents: 19900, platform_fee_cents: 4900 },
};

export const RESERVED_RESELLER_SLUGS = new Set([
  'admin',
  'api',
  'login',
  'signup',
  'dashboard',
  'reseller',
  'checkout',
  'pricing',
  'fidelopass',
  'app',
  'carte',
  'contact',
  'help',
  'support',
]);

export function normalizeResellerPlan(value: unknown): ResellerPlan | null {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'starter') return 'starter';
  if (normalized === 'pro') return 'pro';
  if (normalized === 'premium' || normalized === 'business') return 'premium';
  return null;
}

export function resellerPlanLabel(plan: ResellerPlan) {
  return PLAN_LABELS[plan];
}

export function resellerPlanToCommercePlan(plan: ResellerPlan): 'starter' | 'pro' | 'business' {
  return plan === 'premium' ? 'business' : plan;
}

export function normalizeCurrency(value: unknown, fallback = 'eur') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return /^[a-z]{3}$/.test(normalized) ? normalized : fallback;
}

export function formatResellerAmount(amountCents: number, currency: string) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: normalizeCurrency(currency).toUpperCase(),
    maximumFractionDigits: 0,
  }).format(amountCents / 100);
}

export function normalizeStripeCountryCode(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

const STRIPE_CONNECT_SUPPORTED_COUNTRIES = new Set([
  'AT',
  'AU',
  'BE',
  'BG',
  'BR',
  'CA',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HK',
  'HR',
  'HU',
  'IE',
  'IT',
  'JP',
  'LT',
  'LU',
  'LV',
  'MT',
  'MX',
  'NL',
  'NO',
  'NZ',
  'PL',
  'PT',
  'RO',
  'SE',
  'SG',
  'SI',
  'SK',
  'TH',
  'US',
]);

export function isStripeConnectCountrySupported(value: unknown) {
  const country = normalizeStripeCountryCode(value);
  return Boolean(country && STRIPE_CONNECT_SUPPORTED_COUNTRIES.has(country));
}

export function normalizeHexColor(value: unknown, fallback: string) {
  const normalized = String(value ?? '').trim();
  return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized : fallback;
}

export function normalizePublicSlug(value: unknown) {
  const slug = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (slug.length < 3 || slug.length > 60) return null;
  if (RESERVED_RESELLER_SLUGS.has(slug)) return null;
  return slug;
}

export function publicResellerUrl(slug: string) {
  return `${getPublicSiteUrl()}/r/${slug}`;
}

export function calculateResellerPricing(
  plan: ResellerPlan,
  chosenPriceCents: number,
  setting: Pick<ResellerPlanSetting, 'min_price_cents' | 'platform_fee_cents' | 'currency'>,
): ResellerPricing {
  const price = Math.round(Number(chosenPriceCents));
  const minPrice = Number(setting.min_price_cents);
  const platformFee = Number(setting.platform_fee_cents);

  if (!Number.isFinite(price) || price < minPrice) {
    throw new Error(`Prix trop bas pour le plan ${resellerPlanLabel(plan)}. Minimum: ${formatResellerAmount(minPrice, setting.currency)}.`);
  }
  if (platformFee > price) {
    throw new Error('La part Fidelopass ne peut pas dépasser le prix facturé au commerçant.');
  }

  return {
    plan,
    reseller_price_cents: price,
    platform_fee_cents: platformFee,
    reseller_margin_cents: price - platformFee,
    currency: normalizeCurrency(setting.currency),
  };
}

export function calculatePublicResellerPricing(
  plan: ResellerPlan,
  publicPriceCents: number,
  setting: Pick<ResellerPlanSetting, 'min_price_cents' | 'platform_fee_cents' | 'currency'>,
): Omit<ResellerPublicPlanPrice, 'id' | 'reseller_id' | 'is_enabled'> {
  const pricing = calculateResellerPricing(plan, publicPriceCents, setting);
  return {
    plan,
    public_price_cents: pricing.reseller_price_cents,
    platform_fee_cents: pricing.platform_fee_cents,
    reseller_margin_cents: pricing.reseller_margin_cents,
    currency: pricing.currency,
  };
}

export async function getResellerByUserId(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
) {
  const { data, error } = await db
    .from('resellers')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data as ResellerRecord | null;
}

export async function getResellerPlanSettings(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
) {
  const { data, error } = await db
    .from('reseller_plan_settings')
    .select('*')
    .eq('reseller_id', resellerId);
  if (error) throw error;

  const settings = new Map<ResellerPlan, ResellerPlanSetting>();
  for (const plan of ['starter', 'pro', 'premium'] as ResellerPlan[]) {
    const existing = (data ?? []).find((item: any) => item.plan === plan);
    settings.set(plan, existing ?? {
      id: '',
      reseller_id: resellerId,
      plan,
      min_price_cents: DEFAULT_PLAN_SETTINGS[plan].min_price_cents,
      platform_fee_cents: DEFAULT_PLAN_SETTINGS[plan].platform_fee_cents,
      currency: 'eur',
    });
  }
  return settings;
}

export async function getResellerPlanSetting(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  plan: ResellerPlan,
) {
  const settings = await getResellerPlanSettings(db, resellerId);
  return settings.get(plan)!;
}

export async function ensureDefaultResellerPlanSettings(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  currency = 'eur',
) {
  const rows = (['starter', 'pro', 'premium'] as ResellerPlan[]).map((plan) => ({
    reseller_id: resellerId,
    plan,
    min_price_cents: DEFAULT_PLAN_SETTINGS[plan].min_price_cents,
    platform_fee_cents: DEFAULT_PLAN_SETTINGS[plan].platform_fee_cents,
    currency: normalizeCurrency(currency),
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db
    .from('reseller_plan_settings')
    .upsert(rows, { onConflict: 'reseller_id,plan', ignoreDuplicates: true });
  if (error) throw error;
}

export async function ensureDefaultResellerPublicPrices(
  db: ReturnType<typeof createServiceClient>,
  resellerId: string,
  currency = 'eur',
) {
  const settings = await getResellerPlanSettings(db, resellerId);
  const rows = (['starter', 'pro', 'premium'] as ResellerPlan[]).map((plan) => {
    const setting = settings.get(plan)!;
    const computed = calculatePublicResellerPricing(plan, Number(setting.min_price_cents), {
      min_price_cents: Number(setting.min_price_cents),
      platform_fee_cents: Number(setting.platform_fee_cents),
      currency: setting.currency || currency,
    });
    return {
      reseller_id: resellerId,
      ...computed,
      is_enabled: true,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await db
    .from('reseller_public_plan_prices')
    .upsert(rows, { onConflict: 'reseller_id,plan', ignoreDuplicates: true });
  if (error) throw error;
}

export async function findUserIdByEmail(
  db: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.warn('[reseller] auth user lookup failed:', error.message);
      return null;
    }
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === normalized);
    if (user?.id) return user.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

export async function createOrInviteMerchantUser(
  db: ReturnType<typeof createServiceClient>,
  email: string,
  commerceName: string,
  mode: 'direct' | 'invite',
) {
  const existingUserId = await findUserIdByEmail(db, email);
  if (existingUserId) return { userId: existingUserId, created: false };

  if (mode === 'invite') {
    const redirectTo = `${(process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '')}/login`;
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { commerce_name: commerceName, source: 'reseller_invitation' },
    });
    if (!error && data.user?.id) return { userId: data.user.id, created: true };
    console.warn('[reseller] invite user failed, fallback createUser:', error?.message);
  }

  const generatedPassword = `${randomBytes(18).toString('base64url')}aA1!`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: generatedPassword,
    email_confirm: mode === 'direct',
    user_metadata: { commerce_name: commerceName, source: 'reseller' },
  });
  if (error || !data.user?.id) {
    throw new Error(error?.message ?? 'Impossible de créer le compte commerçant.');
  }
  return { userId: data.user.id, created: true };
}

export async function createOrInviteResellerUser(
  db: ReturnType<typeof createServiceClient>,
  email: string,
  brandName: string,
) {
  const existingUserId = await findUserIdByEmail(db, email);
  if (existingUserId) return { userId: existingUserId, created: false, invited: false };

  const redirectTo = `${getPublicSiteUrl()}/reseller`;
  const { data: inviteData, error: inviteError } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { brand_name: brandName, source: 'admin_reseller_invitation' },
  });
  if (!inviteError && inviteData.user?.id) {
    return { userId: inviteData.user.id, created: true, invited: true };
  }

  console.warn('[reseller] invite reseller user failed, fallback createUser:', inviteError?.message);
  const generatedPassword = `${randomBytes(18).toString('base64url')}aA1!`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: generatedPassword,
    email_confirm: false,
    user_metadata: { brand_name: brandName, source: 'admin_reseller' },
  });
  if (error || !data.user?.id) {
    throw new Error(error?.message ?? 'Impossible de créer le compte revendeur.');
  }
  return { userId: data.user.id, created: true, invited: false };
}

export async function ensureMerchantCommerce(
  db: ReturnType<typeof createServiceClient>,
  params: {
    ownerUserId: string;
    commerceName: string;
    email: string;
    phone?: string | null;
    country?: string | null;
    resellerId: string;
    resellerMerchantId?: string | null;
    plan: ResellerPlan;
    billingStatus: 'unpaid' | 'active' | 'trialing' | 'past_due' | 'canceled';
    paymentMode: ResellerPaymentMode;
    resellerPriceCents: number;
    platformFeeCents: number;
  },
) {
  const { data: existing } = await db
    .from('commerces')
    .select('id, nom')
    .eq('user_id', params.ownerUserId)
    .maybeSingle();

  if (existing?.id) {
    await db
      .from('commerces')
      .update({
        nom: params.commerceName,
        email: params.email,
        telephone: params.phone ?? null,
        plan: resellerPlanToCommercePlan(params.plan),
        billing_status: params.billingStatus,
        reseller_id: params.resellerId,
        reseller_merchant_id: params.resellerMerchantId ?? null,
        reseller_payment_mode: params.paymentMode,
        reseller_price_cents: params.resellerPriceCents,
        reseller_platform_fee_cents: params.platformFeeCents,
        actif: params.billingStatus !== 'past_due' && params.billingStatus !== 'canceled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    return existing.id as string;
  }

  const { data: commerce, error } = await db
    .from('commerces')
    .insert({
      user_id: params.ownerUserId,
      nom: params.commerceName,
      email: params.email,
      telephone: params.phone ?? null,
      plan: resellerPlanToCommercePlan(params.plan),
      billing_status: params.billingStatus,
      onboarding_completed: false,
      reseller_id: params.resellerId,
      reseller_merchant_id: params.resellerMerchantId ?? null,
      reseller_payment_mode: params.paymentMode,
      reseller_price_cents: params.resellerPriceCents,
      reseller_platform_fee_cents: params.platformFeeCents,
      actif: true,
    })
    .select('id')
    .single();

  if (error || !commerce?.id) {
    throw new Error(error?.message ?? 'Impossible de créer le commerce.');
  }

  await db
    .from('points_vente')
    .insert({
      commerce_id: commerce.id,
      nom: params.commerceName,
      principal: true,
      actif: true,
    })
    .then(({ error: pointError }) => {
      if (pointError) console.warn('[reseller] point de vente creation failed:', pointError.message);
    });

  return commerce.id as string;
}

export function stripeApplicationFeePercent(platformFeeCents: number, priceCents: number) {
  if (priceCents <= 0) return 0;
  return Number(Math.min(100, Math.max(0, (platformFeeCents / priceCents) * 100)).toFixed(4));
}

export async function createResellerStripePrice(
  stripe: Stripe,
  params: {
    plan: ResellerPlan;
    amountCents: number;
    currency: string;
    resellerId: string;
    merchantId: string;
  },
) {
  const product = await stripe.products.create({
    name: `Fidelopass ${resellerPlanLabel(params.plan)} revendeur`,
    description: `Abonnement ${resellerPlanLabel(params.plan)} via revendeur Fidelopass`,
    metadata: {
      kind: 'fidelopass_reseller_subscription',
      reseller_id: params.resellerId,
      merchant_id: params.merchantId,
      plan: params.plan,
    },
  });

  return stripe.prices.create({
    product: product.id,
    unit_amount: params.amountCents,
    currency: params.currency,
    recurring: { interval: 'month' },
    metadata: {
      kind: 'fidelopass_reseller_subscription',
      reseller_id: params.resellerId,
      merchant_id: params.merchantId,
      plan: params.plan,
    },
  });
}
