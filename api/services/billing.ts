import { createServiceClient } from '../../src/lib/supabase';

export type BillingRecord = {
  id: string;
  plan: string | null;
  billing_status: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  billing_currency: string | null;
  billing_country: string | null;
  billing_currency_locked_at: string | null;
  trial_ends_at: string | null;
  billing_interval: string | null;
  billing_commitment: string | null;
  billing_current_period_end: string | null;
  billing_cancel_at_period_end: boolean | null;
  billing_cancel_at: string | null;
  billing_canceled_at: string | null;
  billing_access_ends_at: string | null;
  onboarding_completed: boolean | null;
};

export type BillingStatusPayload = {
  has_commerce: boolean;
  commerce_id: string | null;
  plan: string | null;
  billing_status: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  billing_currency: string;
  billing_country: string | null;
  billing_currency_locked_at: string | null;
  trial_ends_at: string | null;
  billing_interval: string | null;
  billing_commitment: string | null;
  billing_current_period_end: string | null;
  billing_cancel_at_period_end: boolean;
  billing_cancel_at: string | null;
  billing_canceled_at: string | null;
  billing_access_ends_at: string | null;
  trial_active: boolean;
  has_used_trial: boolean;
  one_time_access_active: boolean;
  has_access: boolean;
  needs_payment: boolean;
  can_open_portal: boolean;
  can_change_plan: boolean;
  can_cancel: boolean;
  can_reactivate: boolean;
  is_subscription: boolean;
  is_one_time_access: boolean;
  renewal_or_access_end_at: string | null;
  onboarding_completed: boolean;
};

const ACTIVE_BILLING_STATUSES = new Set(['active', 'trialing']);

function normalizeBillingStatus(status: string | null | undefined) {
  return (status ?? 'unpaid').toLowerCase();
}

function isFutureDate(value: string | null | undefined) {
  if (!value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

export function buildBillingStatusPayload(record: BillingRecord | null): BillingStatusPayload {
  if (!record) {
    return {
      has_commerce: false,
      commerce_id: null,
      plan: null,
      billing_status: 'unpaid',
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_price_id: null,
      billing_currency: 'eur',
      billing_country: null,
      billing_currency_locked_at: null,
      trial_ends_at: null,
      billing_interval: null,
      billing_commitment: null,
      billing_current_period_end: null,
      billing_cancel_at_period_end: false,
      billing_cancel_at: null,
      billing_canceled_at: null,
      billing_access_ends_at: null,
      trial_active: false,
      has_used_trial: false,
      one_time_access_active: false,
      has_access: false,
      needs_payment: true,
      can_open_portal: false,
      can_change_plan: false,
      can_cancel: false,
      can_reactivate: false,
      is_subscription: false,
      is_one_time_access: false,
      renewal_or_access_end_at: null,
      onboarding_completed: false,
    };
  }

  const billingStatus = normalizeBillingStatus(record.billing_status);
  const trialActive = isFutureDate(record.trial_ends_at);
  const oneTimeAccessActive = isFutureDate(record.billing_access_ends_at);
  const periodAccessActive = Boolean(record.billing_cancel_at_period_end) && isFutureDate(record.billing_current_period_end);
  const hasSubscription = Boolean(record.stripe_subscription_id);
  const isSubscription = hasSubscription && record.billing_interval !== 'one_time';
  const isOneTimeAccess = record.billing_interval === 'one_time' || (!hasSubscription && Boolean(record.billing_access_ends_at));
  const hasAccess = ACTIVE_BILLING_STATUSES.has(billingStatus) || trialActive || oneTimeAccessActive || periodAccessActive;
  const isAnnualMonthlyCommitment = record.billing_commitment === 'annual-12m-monthly';

  return {
    has_commerce: true,
    commerce_id: record.id,
    plan: record.plan,
    billing_status: billingStatus,
    stripe_subscription_id: record.stripe_subscription_id,
    stripe_customer_id: record.stripe_customer_id,
    stripe_price_id: record.stripe_price_id,
    billing_currency: record.billing_currency === 'chf' ? 'chf' : 'eur',
    billing_country: record.billing_country,
    billing_currency_locked_at: record.billing_currency_locked_at,
    trial_ends_at: record.trial_ends_at,
    billing_interval: record.billing_interval,
    billing_commitment: record.billing_commitment,
    billing_current_period_end: record.billing_current_period_end,
    billing_cancel_at_period_end: Boolean(record.billing_cancel_at_period_end),
    billing_cancel_at: record.billing_cancel_at,
    billing_canceled_at: record.billing_canceled_at,
    billing_access_ends_at: record.billing_access_ends_at,
    trial_active: trialActive,
    has_used_trial: Boolean(record.trial_ends_at),
    one_time_access_active: oneTimeAccessActive,
    has_access: hasAccess,
    needs_payment: !hasAccess,
    can_open_portal: Boolean(record.stripe_customer_id || record.stripe_subscription_id),
    can_change_plan: isSubscription && !isAnnualMonthlyCommitment,
    can_cancel: isSubscription && !isAnnualMonthlyCommitment && billingStatus !== 'canceled',
    can_reactivate: isSubscription && Boolean(record.billing_cancel_at_period_end) && billingStatus !== 'canceled',
    is_subscription: isSubscription,
    is_one_time_access: isOneTimeAccess,
    renewal_or_access_end_at: record.billing_access_ends_at ?? record.billing_current_period_end ?? record.trial_ends_at,
    onboarding_completed: Boolean(record.onboarding_completed),
  };
}

const ADMIN_BYPASS_EMAILS = new Set([
  'bilelel@live.fr',
  'bilelel629@gmail.com',
  ...(process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
]);

function buildAdminBypassPayload(record: BillingRecord | null): BillingStatusPayload {
  return {
    has_commerce: Boolean(record),
    commerce_id: record?.id ?? null,
    plan: record?.plan ?? 'business',
    billing_status: 'active',
    stripe_subscription_id: record?.stripe_subscription_id ?? null,
    stripe_customer_id: record?.stripe_customer_id ?? null,
    stripe_price_id: record?.stripe_price_id ?? null,
    billing_currency: record?.billing_currency === 'chf' ? 'chf' : 'eur',
    billing_country: record?.billing_country ?? null,
    billing_currency_locked_at: record?.billing_currency_locked_at ?? null,
    trial_ends_at: null,
    billing_interval: 'month',
    billing_commitment: 'monthly-flex',
    billing_current_period_end: null,
    billing_cancel_at_period_end: false,
    billing_cancel_at: null,
    billing_canceled_at: null,
    billing_access_ends_at: null,
    trial_active: false,
    has_used_trial: true,
    one_time_access_active: false,
    has_access: true,
    needs_payment: false,
    can_open_portal: false,
    can_change_plan: false,
    can_cancel: false,
    can_reactivate: false,
    is_subscription: false,
    is_one_time_access: false,
    renewal_or_access_end_at: null,
    onboarding_completed: Boolean(record?.onboarding_completed ?? true),
  };
}

export async function getBillingStatusForUser(userId: string, userEmail?: string): Promise<BillingStatusPayload> {
  // Bypass abonnement pour les comptes admin — pas d'appel Supabase supplémentaire
  if (userEmail && ADMIN_BYPASS_EMAILS.has(userEmail.toLowerCase())) {
    const db = createServiceClient();
    const { data } = await db
      .from('commerces')
      .select('id, plan, stripe_subscription_id, stripe_customer_id, stripe_price_id, billing_currency, billing_country, billing_currency_locked_at, onboarding_completed')
      .eq('user_id', userId)
      .single();
    return buildAdminBypassPayload((data as BillingRecord | null) ?? null);
  }

  const db = createServiceClient();
  const { data } = await db
    .from('commerces')
    .select(`
      id,
      plan,
      billing_status,
      stripe_subscription_id,
      stripe_customer_id,
      stripe_price_id,
      billing_currency,
      billing_country,
      billing_currency_locked_at,
      trial_ends_at,
      billing_interval,
      billing_commitment,
      billing_current_period_end,
      billing_cancel_at_period_end,
      billing_cancel_at,
      billing_canceled_at,
      billing_access_ends_at,
      onboarding_completed
    `)
    .eq('user_id', userId)
    .single();

  return buildBillingStatusPayload((data as BillingRecord | null) ?? null);
}
