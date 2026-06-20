-- Multicurrency billing foundation.
-- Existing merchants remain in EUR and existing Stripe subscriptions are not
-- recreated or modified.

ALTER TABLE public.commerces
  ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT 'eur',
  ADD COLUMN IF NOT EXISTS billing_country TEXT,
  ADD COLUMN IF NOT EXISTS billing_currency_locked_at TIMESTAMPTZ;

UPDATE public.commerces
SET
  billing_currency = 'eur',
  billing_currency_locked_at = COALESCE(billing_currency_locked_at, now())
WHERE stripe_subscription_id IS NOT NULL
  AND billing_currency_locked_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerces_billing_currency_check'
      AND conrelid = 'public.commerces'::regclass
  ) THEN
    ALTER TABLE public.commerces
      ADD CONSTRAINT commerces_billing_currency_check
      CHECK (billing_currency IN ('eur', 'chf'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerces_billing_country_check'
      AND conrelid = 'public.commerces'::regclass
  ) THEN
    ALTER TABLE public.commerces
      ADD CONSTRAINT commerces_billing_country_check
      CHECK (billing_country IS NULL OR billing_country ~ '^[A-Z]{2}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commerces_billing_currency
  ON public.commerces (billing_currency);
