import { createServiceClient } from '../../src/lib/supabase';

export type BillingRecord = {
  id: string;
  plan: string | null;
  billing_status: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  onboarding_completed: boolean | null;
};

export type BillingStatusPayload = {
  access_state:
    | 'no_commerce'
    | 'account_created_no_subscription'
    | 'checkout_pending'
    | 'trial_active'
    | 'subscription_active'
    | 'subscription_past_due'
    | 'subscription_cancelled'
    | 'onboarding_not_completed'
    | 'dashboard_ready';
  recommended_redirect: '/abonnement/choix' | '/onboarding' | '/dashboard';
  has_commerce: boolean;
  commerce_id: string | null;
  plan: string | null;
  billing_status: string;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  trial_active: boolean;
  has_access: boolean;
  needs_payment: boolean;
  onboarding_completed: boolean;
};

const ACTIVE_BILLING_STATUSES = new Set(['active']);

function normalizeBillingStatus(status: string | null | undefined) {
  return (status ?? 'unpaid').toLowerCase();
}

function isTrialActive(trialEndsAt: string | null | undefined) {
  if (!trialEndsAt) return false;
  const ts = Date.parse(trialEndsAt);
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

export function buildBillingStatusPayload(record: BillingRecord | null): BillingStatusPayload {
  if (!record) {
    return {
      access_state: 'no_commerce',
      recommended_redirect: '/abonnement/choix',
      has_commerce: false,
      commerce_id: null,
      plan: null,
      billing_status: 'unpaid',
      stripe_subscription_id: null,
      trial_ends_at: null,
      trial_active: false,
      has_access: false,
      needs_payment: true,
      onboarding_completed: false,
    };
  }

  const billingStatus = normalizeBillingStatus(record.billing_status);
  const trialActive = isTrialActive(record.trial_ends_at);
  const isTrialing = billingStatus === 'trialing';
  // Compat: some legacy rows can be trialing without explicit trial_ends_at.
  const trialingWithUnknownEnd = isTrialing && !record.trial_ends_at;
  const hasAccess = ACTIVE_BILLING_STATUSES.has(billingStatus) || trialActive || trialingWithUnknownEnd;
  const onboardingCompleted = Boolean(record.onboarding_completed);

  const accessState: BillingStatusPayload['access_state'] = (() => {
    if (!hasAccess) {
      if (billingStatus === 'past_due') return 'subscription_past_due';
      if (billingStatus === 'canceled' || billingStatus === 'cancelled') return 'subscription_cancelled';
      if (billingStatus === 'unpaid' && record.stripe_subscription_id) return 'checkout_pending';
      return 'account_created_no_subscription';
    }
    if (!onboardingCompleted) return 'onboarding_not_completed';
    if (trialActive || isTrialing || trialingWithUnknownEnd) return 'trial_active';
    return 'dashboard_ready';
  })();

  const recommendedRedirect: BillingStatusPayload['recommended_redirect'] = !hasAccess
    ? '/abonnement/choix'
    : onboardingCompleted
      ? '/dashboard'
      : '/onboarding';

  return {
    access_state: accessState,
    recommended_redirect: recommendedRedirect,
    has_commerce: true,
    commerce_id: record.id,
    plan: record.plan,
    billing_status: billingStatus,
    stripe_subscription_id: record.stripe_subscription_id,
    trial_ends_at: record.trial_ends_at,
    trial_active: trialActive,
    has_access: hasAccess,
    needs_payment: !hasAccess,
    onboarding_completed: onboardingCompleted,
  };
}

export async function getBillingStatusForUser(userId: string): Promise<BillingStatusPayload> {
  const db = createServiceClient();
  let result = await db
    .from('commerces')
    .select('id, plan, billing_status, stripe_subscription_id, trial_ends_at, onboarding_completed')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (result.error && /created_at/i.test(result.error.message ?? '')) {
    result = await db
      .from('commerces')
      .select('id, plan, billing_status, stripe_subscription_id, trial_ends_at, onboarding_completed')
      .eq('user_id', userId)
      .limit(1);
  }

  const { data, error } = result;

  if (error) {
    // Cas normal: aucun commerce encore créé pour cet utilisateur.
    if (error.code === 'PGRST116' || /0 rows/i.test(error.message ?? '')) {
      return buildBillingStatusPayload(null);
    }
    // Les autres erreurs doivent remonter (pour éviter un faux "non abonné").
    throw error;
  }

  const record = Array.isArray(data) ? (data[0] ?? null) : data;
  return buildBillingStatusPayload((record as BillingRecord | null) ?? null);
}
