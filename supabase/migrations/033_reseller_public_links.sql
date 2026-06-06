-- Public reseller links and referral tracking.

ALTER TABLE public.resellers
  ADD COLUMN IF NOT EXISTS public_slug TEXT,
  ADD COLUMN IF NOT EXISTS public_link_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_signup_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS resellers_public_slug_unique
  ON public.resellers(public_slug)
  WHERE public_slug IS NOT NULL;

ALTER TABLE public.reseller_merchants
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual_add';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reseller_merchants_source_check'
  ) THEN
    ALTER TABLE public.reseller_merchants
      ADD CONSTRAINT reseller_merchants_source_check
      CHECK (source IN ('manual_add', 'public_link'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reseller_public_plan_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'pro', 'premium')),
  public_price_cents INTEGER NOT NULL CHECK (public_price_cents >= 0),
  platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
  reseller_margin_cents INTEGER NOT NULL CHECK (reseller_margin_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'eur',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reseller_id, plan)
);

CREATE INDEX IF NOT EXISTS reseller_public_plan_prices_reseller_idx
  ON public.reseller_public_plan_prices(reseller_id);

CREATE TABLE IF NOT EXISTS public.reseller_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  reseller_merchant_id UUID REFERENCES public.reseller_merchants(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.commerces(id) ON DELETE SET NULL,
  merchant_name TEXT,
  merchant_email TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'pro', 'premium')),
  public_price_cents INTEGER NOT NULL CHECK (public_price_cents >= 0),
  platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
  reseller_margin_cents INTEGER NOT NULL CHECK (reseller_margin_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'eur',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'checkout_started', 'paid', 'active', 'abandoned', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'public_link' CHECK (source IN ('public_link')),
  checkout_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reseller_referrals_reseller_idx
  ON public.reseller_referrals(reseller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS reseller_referrals_checkout_idx
  ON public.reseller_referrals(checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.reseller_link_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'plan_click', 'signup_started', 'checkout_started', 'checkout_completed')),
  plan TEXT CHECK (plan IN ('starter', 'pro', 'premium')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reseller_link_events_reseller_idx
  ON public.reseller_link_events(reseller_id, created_at DESC);

ALTER TABLE public.reseller_public_plan_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_link_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reseller_public_prices_owner_select" ON public.reseller_public_plan_prices;
CREATE POLICY "reseller_public_prices_owner_select"
  ON public.reseller_public_plan_prices
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.resellers r
      WHERE r.id = reseller_public_plan_prices.reseller_id
        AND r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "reseller_referrals_owner_select" ON public.reseller_referrals;
CREATE POLICY "reseller_referrals_owner_select"
  ON public.reseller_referrals
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.resellers r
      WHERE r.id = reseller_referrals.reseller_id
        AND r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "reseller_link_events_owner_select" ON public.reseller_link_events;
CREATE POLICY "reseller_link_events_owner_select"
  ON public.reseller_link_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.resellers r
      WHERE r.id = reseller_link_events.reseller_id
        AND r.user_id = auth.uid()
    )
  );

DROP TRIGGER IF EXISTS update_reseller_public_plan_prices_updated_at ON public.reseller_public_plan_prices;
CREATE TRIGGER update_reseller_public_plan_prices_updated_at
  BEFORE UPDATE ON public.reseller_public_plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_reseller_referrals_updated_at ON public.reseller_referrals;
CREATE TRIGGER update_reseller_referrals_updated_at
  BEFORE UPDATE ON public.reseller_referrals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
