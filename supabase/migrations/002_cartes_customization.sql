-- =====================================================
-- Fidelopass — Personnalisation avancée des cartes
-- Exécuter dans l'éditeur SQL de Supabase
-- =====================================================

ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS logo_url         TEXT,
  ADD COLUMN IF NOT EXISTS strip_url        TEXT,
  ADD COLUMN IF NOT EXISTS strip_position   TEXT DEFAULT 'center',
  ADD COLUMN IF NOT EXISTS tampon_icon_url  TEXT,
  ADD COLUMN IF NOT EXISTS barcode_type     TEXT DEFAULT 'QR',
  ADD COLUMN IF NOT EXISTS label_client     TEXT DEFAULT 'Client';

-- Bucket Supabase Storage pour les images de cartes (à créer manuellement si pas encore fait)
-- Nom du bucket : "cartes" — public access activé
