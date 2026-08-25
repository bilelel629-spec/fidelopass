-- Espace fidelite embarquable: normalisation telephone, configuration par
-- commerce et authentification OTP totalement isolee des comptes commercants.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS telephone_e164 TEXT;

UPDATE public.clients
SET telephone_e164 = CASE
  WHEN telephone IS NULL OR btrim(telephone) = '' THEN NULL
  WHEN regexp_replace(telephone, '\D', '', 'g') ~ '^0[67][0-9]{8}$'
    THEN '+33' || substr(regexp_replace(telephone, '\D', '', 'g'), 2)
  WHEN regexp_replace(telephone, '\D', '', 'g') ~ '^33[67][0-9]{8}$'
    THEN '+' || regexp_replace(telephone, '\D', '', 'g')
  WHEN telephone LIKE '+%'
    AND regexp_replace(telephone, '\D', '', 'g') ~ '^[1-9][0-9]{7,14}$'
    THEN '+' || regexp_replace(telephone, '\D', '', 'g')
  ELSE NULL
END
WHERE telephone_e164 IS NULL;

CREATE INDEX IF NOT EXISTS idx_clients_telephone_e164
  ON public.clients(telephone_e164)
  WHERE telephone_e164 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_carte_telephone_e164_unique
  ON public.clients(carte_id, telephone_e164)
  WHERE telephone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.widget_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL UNIQUE REFERENCES public.commerces(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE DEFAULT ('wgt_' || replace(gen_random_uuid()::text, '-', '')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  allowed_origins TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  portal_url TEXT,
  theme JSONB NOT NULL DEFAULT '{}'::JSONB,
  display_options JSONB NOT NULL DEFAULT '{"show_history":true,"show_wallet_links":true}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT widget_configs_public_key_check CHECK (public_key ~ '^wgt_[a-zA-Z0-9_-]{16,80}$')
);

CREATE TABLE IF NOT EXISTS public.widget_auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_config_id UUID NOT NULL REFERENCES public.widget_configs(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  otp_hash TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'ignored'
    CHECK (delivery_status IN ('pending', 'sent', 'ignored', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_auth_challenges_phone_recent
  ON public.widget_auth_challenges(widget_config_id, phone_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_widget_auth_challenges_ip_recent
  ON public.widget_auth_challenges(widget_config_id, ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_widget_auth_challenges_expiry
  ON public.widget_auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS public.widget_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_config_id UUID NOT NULL REFERENCES public.widget_configs(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_sessions_active
  ON public.widget_sessions(widget_config_id, token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_widget_sessions_expiry
  ON public.widget_sessions(expires_at);

ALTER TABLE public.widget_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.widget_configs;
CREATE POLICY "service role full access" ON public.widget_configs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access" ON public.widget_auth_challenges;
CREATE POLICY "service role full access" ON public.widget_auth_challenges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access" ON public.widget_sessions;
CREATE POLICY "service role full access" ON public.widget_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.widget_configs FROM anon, authenticated;
REVOKE ALL ON public.widget_auth_challenges FROM anon, authenticated;
REVOKE ALL ON public.widget_sessions FROM anon, authenticated;
GRANT ALL ON public.widget_configs TO service_role;
GRANT ALL ON public.widget_auth_challenges TO service_role;
GRANT ALL ON public.widget_sessions TO service_role;

DROP TRIGGER IF EXISTS widget_configs_updated_at ON public.widget_configs;
CREATE TRIGGER widget_configs_updated_at
  BEFORE UPDATE ON public.widget_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
