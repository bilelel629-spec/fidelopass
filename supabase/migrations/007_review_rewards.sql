-- =====================================================
-- Fidelopass — Migration 007 : Récompense avis Google
-- Exécuter dans l'éditeur SQL de Supabase
-- =====================================================

-- Colonnes sur la table cartes
ALTER TABLE cartes
  ADD COLUMN IF NOT EXISTS review_reward_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reward_value   INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS google_maps_url        TEXT;

-- Table des réclamations d'avis (1 par client par carte)
CREATE TABLE IF NOT EXISTS review_rewards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id)  ON DELETE CASCADE NOT NULL,
  carte_id    UUID REFERENCES cartes(id)   ON DELETE CASCADE NOT NULL,
  claimed_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, carte_id)
);

-- Index pour les lookups fréquents
CREATE INDEX IF NOT EXISTS idx_review_rewards_client  ON review_rewards (client_id);
CREATE INDEX IF NOT EXISTS idx_review_rewards_carte   ON review_rewards (carte_id);

-- RLS
ALTER TABLE review_rewards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON review_rewards
  USING (true)
  WITH CHECK (true);
