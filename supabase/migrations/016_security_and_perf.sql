-- Sécurité & performances : indexes manquants, RLS, auth token Apple, idempotence Stripe

-- ─────────────────────────────────────────────────────────────
-- 1. Indexes manquants
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_telephone
  ON clients(telephone);

CREATE INDEX IF NOT EXISTS idx_clients_birthday
  ON clients(date_naissance)
  WHERE date_naissance IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_fcm_token
  ON clients(fcm_token)
  WHERE fcm_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_type
  ON transactions(type);

-- ─────────────────────────────────────────────────────────────
-- 2. Fix RLS clients_public_insert
--    Avant : WITH CHECK (true) → n'importe qui pouvait insérer
--    Après : restreint aux cartes actives existantes
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "clients_public_insert" ON clients;

CREATE POLICY "clients_public_insert" ON clients
  FOR INSERT WITH CHECK (
    carte_id IN (SELECT id FROM cartes WHERE actif = true)
  );

-- ─────────────────────────────────────────────────────────────
-- 3. Token d'authentification Apple Wallet sécurisé
--    Remplace l'usage de client.id (UUID prévisible) comme authenticationToken
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS apple_auth_token TEXT;

-- Générer un token pour tous les clients existants
UPDATE public.clients
  SET apple_auth_token = encode(gen_random_bytes(20), 'hex')
  WHERE apple_auth_token IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 4. Table d'idempotence pour les webhooks Stripe
--    Évite le double-traitement d'un même event
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_events_processed (
  event_id    TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.stripe_events_processed ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON stripe_events_processed
  USING (auth.role() = 'service_role');

-- Nettoyage automatique des events de plus de 30 jours
CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_at
  ON stripe_events_processed(processed_at);

-- ─────────────────────────────────────────────────────────────
-- 5. Fonction atomique d'ajustement de score (évite race conditions)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION adjust_client_score_atomic(
  p_client_id    UUID,
  p_commerce_id  UUID,
  p_delta        INTEGER,
  p_score_type   TEXT,
  p_seuil        INTEGER DEFAULT 100
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_points   INTEGER;
  v_current_tampons  INTEGER;
  v_recompenses      INTEGER;
  v_new_score        INTEGER;
  v_final_score      INTEGER;
  v_new_recompenses  INTEGER;
BEGIN
  -- Verrou row-level pour éviter les mises à jour concurrentes
  SELECT points_actuels, tampons_actuels, recompenses_obtenues
    INTO v_current_points, v_current_tampons, v_recompenses
    FROM clients
   WHERE id = p_client_id AND commerce_id = p_commerce_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client introuvable';
  END IF;

  v_new_recompenses := COALESCE(v_recompenses, 0);

  IF p_score_type = 'points' THEN
    v_new_score := GREATEST(0, COALESCE(v_current_points, 0) + p_delta);
    -- Calcul des récompenses si ajout et seuil atteint
    IF p_delta > 0 AND p_seuil > 0 THEN
      WHILE v_new_score >= p_seuil LOOP
        v_new_recompenses := v_new_recompenses + 1;
        v_new_score := v_new_score - p_seuil;
      END LOOP;
      -- On garde le score au seuil si dépassé (comportement app actuel)
      v_final_score := LEAST(v_new_score, p_seuil);
    ELSE
      v_final_score := v_new_score;
    END IF;

    UPDATE clients SET
      points_actuels     = v_final_score,
      recompenses_obtenues = v_new_recompenses,
      derniere_visite    = NOW(),
      updated_at         = NOW()
    WHERE id = p_client_id;

    RETURN json_build_object(
      'points_actuels',      v_final_score,
      'tampons_actuels',     v_current_tampons,
      'recompenses_obtenues', v_new_recompenses
    );

  ELSIF p_score_type = 'tampons' THEN
    v_new_score := GREATEST(0, COALESCE(v_current_tampons, 0) + p_delta);
    -- Récompense tampons : quand on atteint le seuil
    IF p_delta > 0 AND p_seuil > 0 AND v_new_score >= p_seuil THEN
      v_new_recompenses := v_new_recompenses + FLOOR(v_new_score::FLOAT / p_seuil)::INTEGER;
      v_final_score := v_new_score % p_seuil;
    ELSE
      v_final_score := v_new_score;
    END IF;

    UPDATE clients SET
      tampons_actuels      = v_final_score,
      recompenses_obtenues = v_new_recompenses,
      derniere_visite      = NOW(),
      updated_at           = NOW()
    WHERE id = p_client_id;

    RETURN json_build_object(
      'points_actuels',      v_current_points,
      'tampons_actuels',     v_final_score,
      'recompenses_obtenues', v_new_recompenses
    );

  ELSE
    RAISE EXCEPTION 'score_type invalide : %', p_score_type;
  END IF;
END;
$$;
