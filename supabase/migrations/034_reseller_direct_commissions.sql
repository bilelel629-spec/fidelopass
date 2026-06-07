-- Reseller V1: Fidelopass collects subscriptions directly and tracks reseller commissions.

ALTER TABLE public.reseller_merchants
  DROP CONSTRAINT IF EXISTS reseller_merchants_payment_mode_check;

ALTER TABLE public.reseller_merchants
  ADD CONSTRAINT reseller_merchants_payment_mode_check
  CHECK (payment_mode IN ('stripe_direct', 'stripe_connect', 'manual', 'bank_transfer', 'cash'));

CREATE TABLE IF NOT EXISTS public.reseller_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  reseller_merchant_id UUID REFERENCES public.reseller_merchants(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.commerces(id) ON DELETE SET NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_invoice_id TEXT,
  stripe_charge_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_event_id TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  plan TEXT CHECK (plan IN ('starter', 'pro', 'premium')),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  reseller_commission_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'eur',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled', 'refunded')),
  paid_at TIMESTAMPTZ,
  paid_by UUID,
  paid_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS reseller_commissions_stripe_invoice_unique
  ON public.reseller_commissions(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reseller_commissions_reseller_status_idx
  ON public.reseller_commissions(reseller_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS reseller_commissions_merchant_idx
  ON public.reseller_commissions(merchant_id, created_at DESC)
  WHERE merchant_id IS NOT NULL;

ALTER TABLE public.reseller_commissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reseller_commissions_owner_select" ON public.reseller_commissions;
CREATE POLICY "reseller_commissions_owner_select"
  ON public.reseller_commissions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.resellers r
      WHERE r.id = reseller_commissions.reseller_id
        AND r.user_id = auth.uid()
    )
  );

DROP TRIGGER IF EXISTS update_reseller_commissions_updated_at ON public.reseller_commissions;
CREATE TRIGGER update_reseller_commissions_updated_at
  BEFORE UPDATE ON public.reseller_commissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
