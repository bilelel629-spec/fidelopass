-- =====================================================
-- Fidelopass — Programme partenaires white label
-- =====================================================

CREATE TABLE IF NOT EXISTS public.partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  plan VARCHAR(32) NOT NULL DEFAULT 'white_label_starter',
  included_commerces INTEGER NOT NULL DEFAULT 10,
  monthly_price_cents INTEGER NOT NULL DEFAULT 19900,
  logo_url TEXT,
  primary_color VARCHAR(7) DEFAULT '#2563eb',
  secondary_color VARCHAR(7) DEFAULT '#4f46e5',
  support_email VARCHAR(255),
  support_phone VARCHAR(50),
  website_url TEXT,
  custom_domain TEXT,
  white_label_enabled BOOLEAN NOT NULL DEFAULT true,
  hide_fidelopass_branding BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partners_plan_check CHECK (plan IN ('white_label_starter', 'white_label_pro', 'custom')),
  CONSTRAINT partners_included_commerces_check CHECK (included_commerces >= 0),
  CONSTRAINT partners_monthly_price_check CHECK (monthly_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS public.partner_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'owner',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(partner_id, user_id),
  CONSTRAINT partner_users_role_check CHECK (role IN ('owner', 'manager', 'viewer'))
);

ALTER TABLE public.commerces
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS white_label_enabled BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_partners_slug ON public.partners(slug);
CREATE INDEX IF NOT EXISTS idx_partners_active ON public.partners(active);
CREATE INDEX IF NOT EXISTS idx_partner_users_user ON public.partner_users(user_id, active);
CREATE INDEX IF NOT EXISTS idx_partner_users_partner ON public.partner_users(partner_id, active);
CREATE INDEX IF NOT EXISTS idx_commerces_partner ON public.commerces(partner_id);

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.partners;
CREATE POLICY "service role full access" ON public.partners
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access" ON public.partner_users;
CREATE POLICY "service role full access" ON public.partner_users
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS partners_updated_at ON public.partners;
CREATE TRIGGER partners_updated_at BEFORE UPDATE ON public.partners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS partner_users_updated_at ON public.partner_users;
CREATE TRIGGER partner_users_updated_at BEFORE UPDATE ON public.partner_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
