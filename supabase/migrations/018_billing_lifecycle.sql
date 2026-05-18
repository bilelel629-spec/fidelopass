-- Billing lifecycle fields used to keep Stripe subscription state explicit.
-- Idempotent so it can be applied safely on environments that already received
-- part of the billing schema manually.

ALTER TABLE public.commerces
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_interval TEXT,
  ADD COLUMN IF NOT EXISTS billing_commitment TEXT,
  ADD COLUMN IF NOT EXISTS billing_current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_cancel_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_access_ends_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerces_billing_interval_check'
      AND conrelid = 'public.commerces'::regclass
  ) THEN
    ALTER TABLE public.commerces
      ADD CONSTRAINT commerces_billing_interval_check
      CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year', 'one_time'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerces_billing_commitment_check'
      AND conrelid = 'public.commerces'::regclass
  ) THEN
    ALTER TABLE public.commerces
      ADD CONSTRAINT commerces_billing_commitment_check
      CHECK (
        billing_commitment IS NULL
        OR billing_commitment IN ('monthly-flex', 'annual-12m-monthly', 'annual-12m-once', 'unknown')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commerces_stripe_price_id
  ON public.commerces (stripe_price_id);

CREATE INDEX IF NOT EXISTS idx_commerces_billing_current_period_end
  ON public.commerces (billing_current_period_end);

