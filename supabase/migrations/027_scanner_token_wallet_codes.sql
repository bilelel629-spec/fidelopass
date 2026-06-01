-- =====================================================
-- Fidelopass — Scanner mobile token + codes Wallet fiables
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS wallet_code TEXT;

UPDATE public.clients
SET wallet_code = 'FID-' || upper(substr(replace(id::text, '-', ''), 1, 8))
WHERE wallet_code IS NULL OR btrim(wallet_code) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_wallet_code_unique
  ON public.clients(wallet_code)
  WHERE wallet_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_commerce_wallet_code
  ON public.clients(commerce_id, wallet_code)
  WHERE wallet_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scanner_devices_token
  ON public.scanner_devices(scanner_token);

CREATE OR REPLACE FUNCTION public.set_client_wallet_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_code text;
BEGIN
  IF NEW.wallet_code IS NOT NULL AND btrim(NEW.wallet_code) <> '' THEN
    NEW.wallet_code := upper(btrim(NEW.wallet_code));
    RETURN NEW;
  END IF;

  LOOP
    next_code := 'FID-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.clients WHERE wallet_code = next_code
    );
  END LOOP;

  NEW.wallet_code := next_code;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_client_wallet_code ON public.clients;
CREATE TRIGGER trg_set_client_wallet_code
BEFORE INSERT ON public.clients
FOR EACH ROW
EXECUTE FUNCTION public.set_client_wallet_code();
