-- Migration 004 : typographie et options de mise en page avancées
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS police            TEXT    DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS police_taille     INT     DEFAULT 100,
  ADD COLUMN IF NOT EXISTS police_gras       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS texte_alignement  TEXT    DEFAULT 'left',
  ADD COLUMN IF NOT EXISTS strip_plein_largeur BOOLEAN DEFAULT false;
