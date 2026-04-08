-- Migration 006 : personnalisation programme et messages client
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS welcome_message TEXT,
  ADD COLUMN IF NOT EXISTS success_message TEXT,
  ADD COLUMN IF NOT EXISTS rewards_config JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS vip_tiers JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strip_layout TEXT DEFAULT 'background';

