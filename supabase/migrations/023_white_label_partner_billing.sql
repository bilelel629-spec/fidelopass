-- =====================================================
-- Fidelopass — Facturation Stripe des partenaires white label
-- =====================================================

ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'partners_billing_status_check'
  ) THEN
    ALTER TABLE public.partners
      ADD CONSTRAINT partners_billing_status_check
      CHECK (billing_status IN ('unpaid', 'trialing', 'active', 'past_due', 'canceled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_partners_stripe_customer
  ON public.partners(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partners_stripe_subscription
  ON public.partners(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partners_billing_status
  ON public.partners(billing_status);
