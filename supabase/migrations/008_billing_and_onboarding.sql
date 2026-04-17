-- =====================================================
-- Fidelopass — Billing & onboarding access control
-- =====================================================

ALTER TABLE commerces ADD COLUMN IF NOT EXISTS plan VARCHAR(32);
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS billing_status VARCHAR(32) DEFAULT 'unpaid';
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS onboarding_purchased BOOLEAN DEFAULT false;
ALTER TABLE commerces ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_commerces_billing_status ON commerces(billing_status);
CREATE INDEX IF NOT EXISTS idx_commerces_stripe_subscription ON commerces(stripe_subscription_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerces_billing_status_check'
  ) THEN
    ALTER TABLE commerces
      ADD CONSTRAINT commerces_billing_status_check
      CHECK (billing_status IN ('unpaid', 'trialing', 'active', 'past_due', 'canceled'));
  END IF;
END $$;

-- Backfill défensif (anciens comptes déjà actifs)
UPDATE commerces
SET billing_status = 'active'
WHERE stripe_subscription_id IS NOT NULL
  AND (billing_status IS NULL OR billing_status = '');

UPDATE commerces
SET billing_status = 'unpaid'
WHERE billing_status IS NULL OR billing_status = '';

-- On considère les commerces historiques comme onboardés si un nom "réel" existe déjà.
UPDATE commerces
SET onboarding_completed = true
WHERE COALESCE(onboarding_completed, false) = false
  AND nom IS NOT NULL
  AND btrim(nom) <> ''
  AND lower(btrim(nom)) NOT IN ('mon commerce', 'nouveau commerce');
