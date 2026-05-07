-- =====================================================
-- Fidelopass — Scanner caisse clavier / scannette
-- =====================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS wallet_code TEXT;

-- Code stable lisible par scannette. Les anciens QR UUID restent compatibles côté API.
UPDATE public.clients
SET wallet_code = 'FID-' || upper(substr(replace(id::text, '-', ''), 1, 8))
WHERE wallet_code IS NULL OR btrim(wallet_code) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_wallet_code_unique
  ON public.clients(wallet_code)
  WHERE wallet_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_commerce_wallet_code
  ON public.clients(commerce_id, wallet_code)
  WHERE wallet_code IS NOT NULL;
