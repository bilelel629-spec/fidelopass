-- Champs d'adresse détaillés pour l'autocomplétion et la géolocalisation Wallet.
ALTER TABLE public.points_vente
  ADD COLUMN IF NOT EXISTS rue TEXT,
  ADD COLUMN IF NOT EXISTS ville TEXT,
  ADD COLUMN IF NOT EXISTS code_postal TEXT,
  ADD COLUMN IF NOT EXISTS pays TEXT;
