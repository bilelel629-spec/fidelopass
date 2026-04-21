-- =====================================================
-- Fidelopass — Migration 014 : Programmation anniversaire
-- =====================================================

-- Réglages anniversaires portés par la carte (donc par point de vente)
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS birthday_auto_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS birthday_reward_value INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS birthday_push_title TEXT,
  ADD COLUMN IF NOT EXISTS birthday_push_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cartes_birthday_reward_value_check'
  ) THEN
    ALTER TABLE cartes
      ADD CONSTRAINT cartes_birthday_reward_value_check
      CHECK (birthday_reward_value >= 1 AND birthday_reward_value <= 50);
  END IF;
END $$;

-- Déduplication annuelle : 1 bonus anniversaire max par client/carte/an
CREATE TABLE IF NOT EXISTS birthday_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  carte_id UUID NOT NULL REFERENCES cartes(id) ON DELETE CASCADE,
  birth_year INTEGER NOT NULL,
  reward_value INTEGER NOT NULL DEFAULT 1,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, carte_id, birth_year)
);

CREATE INDEX IF NOT EXISTS idx_birthday_rewards_carte_year
  ON birthday_rewards(carte_id, birth_year);

CREATE INDEX IF NOT EXISTS idx_birthday_rewards_client
  ON birthday_rewards(client_id);

-- Compat legacy : certaines bases n'ont pas encore la migration 012
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS date_naissance DATE;

-- Accélère le filtrage des clients éligibles par carte + date de naissance
CREATE INDEX IF NOT EXISTS idx_clients_carte_birth_date
  ON clients(carte_id, date_naissance)
  WHERE date_naissance IS NOT NULL;

-- RLS (même approche que review_rewards)
ALTER TABLE birthday_rewards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON birthday_rewards;
CREATE POLICY "service role full access" ON birthday_rewards
  USING (true)
  WITH CHECK (true);
