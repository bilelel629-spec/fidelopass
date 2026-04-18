-- Migration 009 : branding carte + couleur fond icône notifications + activation récompenses multiples
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS push_icon_bg_color VARCHAR(7) DEFAULT '#6366f1',
  ADD COLUMN IF NOT EXISTS branding_powered_by_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS rewards_multi_enabled BOOLEAN DEFAULT false;

