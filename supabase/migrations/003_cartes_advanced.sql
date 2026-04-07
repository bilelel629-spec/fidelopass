-- Migration 003 : options avancées de personnalisation (dégradé, pattern, emoji tampon)
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS couleur_fond_2  TEXT,
  ADD COLUMN IF NOT EXISTS gradient_angle  INT  DEFAULT 135,
  ADD COLUMN IF NOT EXISTS pattern_type    TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS tampon_emoji    TEXT;
