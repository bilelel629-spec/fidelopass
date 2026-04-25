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

  return {
    has_commerce: true,
    commerce_id: record.id,
    plan: record.plan,
    billing_status: billingStatus,
    stripe_subscription_id: record.stripe_subscription_id,
    trial_ends_at: record.trial_ends_at,
    trial_active: trialActive,
    has_access: hasAccess,
    needs_payment: !hasAccess,
    onboarding_completed: Boolean(record.onboarding_completed),
  };
}

export async function getBillingStatusForUser(userId: string): Promise<BillingStatusPayload> {
  const db = createServiceClient();
  const { data, error } = await db
    .from('commerces')
    .select('id, plan, billing_status, stripe_subscription_id, trial_ends_at, onboarding_completed')
    .eq('user_id', userId)
    .single();

  if (error) {
    // Cas normal: aucun commerce encore créé pour cet utilisateur.
    if (error.code === 'PGRST116' || /0 rows/i.test(error.message ?? '')) {
      return buildBillingStatusPayload(null);
    }
    // Les autres erreurs doivent remonter (pour éviter un faux "non abonné").
    throw error;
  }

  return buildBillingStatusPayload((data as BillingRecord | null) ?? null);
}
