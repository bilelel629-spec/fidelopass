-- =====================================================
-- Fidelopass — Revendeurs V1
-- =====================================================

CREATE TABLE IF NOT EXISTS public.resellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'invoiced',
  status TEXT NOT NULL DEFAULT 'pending',
  country TEXT,
  currency TEXT NOT NULL DEFAULT 'eur',
  stripe_connect_account_id TEXT,
  stripe_onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  stripe_charges_enabled BOOLEAN NOT NULL DEFAULT false,
  stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  brand_name TEXT NOT NULL DEFAULT 'Fidelopass Revendeur',
  brand_logo_url TEXT,
  primary_color VARCHAR(7) NOT NULL DEFAULT '#2563eb',
  secondary_color VARCHAR(7) NOT NULL DEFAULT '#4f46e5',
  support_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resellers_user_unique UNIQUE (user_id),
  CONSTRAINT resellers_type_check CHECK (type IN ('stripe_connect', 'invoiced')),
  CONSTRAINT resellers_status_check CHECK (status IN ('pending', 'approved', 'suspended')),
  CONSTRAINT resellers_currency_check CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT resellers_primary_color_check CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT resellers_secondary_color_check CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resellers_stripe_account_unique
  ON public.resellers(stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resellers_user ON public.resellers(user_id);
CREATE INDEX IF NOT EXISTS idx_resellers_status ON public.resellers(status);
CREATE INDEX IF NOT EXISTS idx_resellers_type ON public.resellers(type);

CREATE TABLE IF NOT EXISTS public.reseller_plan_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  min_price_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'eur',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reseller_plan_settings_plan_check CHECK (plan IN ('starter', 'pro', 'premium')),
  CONSTRAINT reseller_plan_settings_min_price_check CHECK (min_price_cents >= 0),
  CONSTRAINT reseller_plan_settings_platform_fee_check CHECK (platform_fee_cents >= 0),
  CONSTRAINT reseller_plan_settings_fee_lte_price_check CHECK (platform_fee_cents <= min_price_cents),
  CONSTRAINT reseller_plan_settings_currency_check CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT reseller_plan_settings_unique UNIQUE (reseller_id, plan)
);

CREATE INDEX IF NOT EXISTS idx_reseller_plan_settings_reseller
  ON public.reseller_plan_settings(reseller_id);

CREATE TABLE IF NOT EXISTS public.reseller_merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES public.commerces(id) ON DELETE SET NULL,
  merchant_name TEXT NOT NULL,
  merchant_email TEXT NOT NULL,
  merchant_phone TEXT,
  country TEXT,
  plan TEXT NOT NULL,
  reseller_price_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  reseller_margin_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  payment_mode TEXT NOT NULL DEFAULT 'manual',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_checkout_session_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reseller_merchants_plan_check CHECK (plan IN ('starter', 'pro', 'premium')),
  CONSTRAINT reseller_merchants_payment_mode_check CHECK (payment_mode IN ('stripe_connect', 'manual', 'bank_transfer', 'cash')),
  CONSTRAINT reseller_merchants_status_check CHECK (
    subscription_status IN ('pending', 'invited', 'incomplete', 'trialing', 'active', 'past_due', 'suspended', 'cancelled', 'canceled', 'unpaid')
  ),
  CONSTRAINT reseller_merchants_amounts_check CHECK (
    reseller_price_cents >= 0
    AND platform_fee_cents >= 0
    AND reseller_margin_cents >= 0
    AND reseller_margin_cents = reseller_price_cents - platform_fee_cents
  ),
  CONSTRAINT reseller_merchants_currency_check CHECK (currency ~ '^[a-z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_reseller_merchants_reseller
  ON public.reseller_merchants(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_merchants_merchant
  ON public.reseller_merchants(merchant_id)
  WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reseller_merchants_subscription
  ON public.reseller_merchants(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reseller_merchants_status
  ON public.reseller_merchants(subscription_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_merchants_active_merchant_unique
  ON public.reseller_merchants(merchant_id)
  WHERE merchant_id IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS public.reseller_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_merchants INTEGER NOT NULL DEFAULT 0,
  total_platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'eur',
  status TEXT NOT NULL DEFAULT 'draft',
  pdf_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reseller_invoices_status_check CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  CONSTRAINT reseller_invoices_amount_check CHECK (total_merchants >= 0 AND total_platform_fee_cents >= 0),
  CONSTRAINT reseller_invoices_currency_check CHECK (currency ~ '^[a-z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_reseller_invoices_reseller
  ON public.reseller_invoices(reseller_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_invoices_status
  ON public.reseller_invoices(status);

CREATE TABLE IF NOT EXISTS public.reseller_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.reseller_invoices(id) ON DELETE CASCADE,
  reseller_merchant_id UUID REFERENCES public.reseller_merchants(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES public.commerces(id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reseller_invoice_lines_plan_check CHECK (plan IN ('starter', 'pro', 'premium')),
  CONSTRAINT reseller_invoice_lines_fee_check CHECK (platform_fee_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_reseller_invoice_lines_invoice
  ON public.reseller_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_reseller_invoice_lines_merchant
  ON public.reseller_invoice_lines(reseller_merchant_id);

CREATE TABLE IF NOT EXISTS public.reseller_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES public.commerces(id) ON DELETE SET NULL,
  reseller_merchant_id UUID REFERENCES public.reseller_merchants(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  reseller_amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'eur',
  stripe_event_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  stripe_invoice_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reseller_transactions_type_check CHECK (type IN ('subscription_paid', 'refund', 'manual_invoice', 'failed_payment')),
  CONSTRAINT reseller_transactions_currency_check CHECK (currency ~ '^[a-z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_reseller_transactions_reseller
  ON public.reseller_transactions(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_transactions_merchant
  ON public.reseller_transactions(reseller_merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_transactions_event_unique
  ON public.reseller_transactions(stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reseller_transactions_payment_intent
  ON public.reseller_transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reseller_transactions_charge
  ON public.reseller_transactions(stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

ALTER TABLE public.commerces
  ADD COLUMN IF NOT EXISTS reseller_id UUID REFERENCES public.resellers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reseller_merchant_id UUID REFERENCES public.reseller_merchants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reseller_payment_mode TEXT,
  ADD COLUMN IF NOT EXISTS reseller_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS reseller_platform_fee_cents INTEGER;

CREATE INDEX IF NOT EXISTS idx_commerces_reseller
  ON public.commerces(reseller_id)
  WHERE reseller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerces_reseller_merchant
  ON public.commerces(reseller_merchant_id)
  WHERE reseller_merchant_id IS NOT NULL;

ALTER TABLE public.resellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_plan_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reseller_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "resellers_owner_read" ON public.resellers;
CREATE POLICY "resellers_owner_read" ON public.resellers
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "reseller_plan_settings_owner_read" ON public.reseller_plan_settings;
CREATE POLICY "reseller_plan_settings_owner_read" ON public.reseller_plan_settings
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "reseller_merchants_owner_read" ON public.reseller_merchants;
CREATE POLICY "reseller_merchants_owner_read" ON public.reseller_merchants
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "reseller_invoices_owner_read" ON public.reseller_invoices;
CREATE POLICY "reseller_invoices_owner_read" ON public.reseller_invoices
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "reseller_invoice_lines_owner_read" ON public.reseller_invoice_lines;
CREATE POLICY "reseller_invoice_lines_owner_read" ON public.reseller_invoice_lines
  FOR SELECT USING (
    invoice_id IN (
      SELECT id FROM public.reseller_invoices
      WHERE reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "reseller_transactions_owner_read" ON public.reseller_transactions;
CREATE POLICY "reseller_transactions_owner_read" ON public.reseller_transactions
  FOR SELECT USING (
    reseller_id IN (SELECT id FROM public.resellers WHERE user_id = auth.uid())
  );

DROP TRIGGER IF EXISTS resellers_updated_at ON public.resellers;
CREATE TRIGGER resellers_updated_at BEFORE UPDATE ON public.resellers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS reseller_plan_settings_updated_at ON public.reseller_plan_settings;
CREATE TRIGGER reseller_plan_settings_updated_at BEFORE UPDATE ON public.reseller_plan_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS reseller_merchants_updated_at ON public.reseller_merchants;
CREATE TRIGGER reseller_merchants_updated_at BEFORE UPDATE ON public.reseller_merchants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS reseller_invoices_updated_at ON public.reseller_invoices;
CREATE TRIGGER reseller_invoices_updated_at BEFORE UPDATE ON public.reseller_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
