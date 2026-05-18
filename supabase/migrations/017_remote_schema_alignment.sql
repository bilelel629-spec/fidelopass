-- Fidelopass — alignement schema distant avec le code applicatif actuel
-- Migration idempotente: ajoute les objets manquants sans supprimer de donnees.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Colonnes attendues par le dashboard/admin et l'editeur de carte.
ALTER TABLE public.commerces
  ADD COLUMN IF NOT EXISTS plan_override TEXT,
  ADD COLUMN IF NOT EXISTS dashboard_tour_seen BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.cartes
  ADD COLUMN IF NOT EXISTS banner_overlay_opacity INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cartes_banner_overlay_opacity_check'
  ) THEN
    ALTER TABLE public.cartes
      ADD CONSTRAINT cartes_banner_overlay_opacity_check
      CHECK (banner_overlay_opacity >= 0 AND banner_overlay_opacity <= 85);
  END IF;
END $$;

-- Token Apple Wallet distinct du UUID client.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS apple_auth_token TEXT;

ALTER TABLE public.clients
  ALTER COLUMN apple_auth_token SET DEFAULT encode(gen_random_bytes(20), 'hex');

UPDATE public.clients
SET apple_auth_token = encode(gen_random_bytes(20), 'hex')
WHERE apple_auth_token IS NULL;

-- Idempotence utilisee par api/routes/stripe-webhook.ts.
CREATE TABLE IF NOT EXISTS public.stripe_events_processed (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.stripe_events_processed ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stripe_events_processed'
      AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.stripe_events_processed
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_at
  ON public.stripe_events_processed(processed_at);

-- Les endpoints SMS/Apple passent par l'API service role; ces policies evitent les tables RLS sans policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'apple_pass_registrations' AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.apple_pass_registrations
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sms_logs' AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.sms_logs
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sms_scheduled' AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.sms_scheduled
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Creation publique client limitee aux cartes actives existantes.
DROP POLICY IF EXISTS "clients_public_insert" ON public.clients;
CREATE POLICY "clients_public_insert" ON public.clients
  FOR INSERT
  WITH CHECK (
    carte_id IN (SELECT id FROM public.cartes WHERE actif = true)
  );

-- Le code enregistre aussi les retraits manuels.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (
    type::text = ANY (
      ARRAY[
        'ajout_points',
        'ajout_tampon',
        'retrait_points',
        'retrait_tampon',
        'recompense',
        'reset'
      ]::text[]
    )
  );

-- Fonction atomique appelee par api/routes/clients.ts.
CREATE OR REPLACE FUNCTION public.adjust_client_score_atomic(
  p_client_id UUID,
  p_commerce_id UUID,
  p_delta INTEGER,
  p_score_type TEXT,
  p_seuil INTEGER DEFAULT 100
)
RETURNS JSON
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_current_points INTEGER;
  v_current_tampons INTEGER;
  v_recompenses INTEGER;
  v_new_score INTEGER;
  v_final_score INTEGER;
  v_new_recompenses INTEGER;
BEGIN
  SELECT points_actuels, tampons_actuels, recompenses_obtenues
    INTO v_current_points, v_current_tampons, v_recompenses
    FROM public.clients
   WHERE id = p_client_id
     AND commerce_id = p_commerce_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client introuvable';
  END IF;

  v_new_recompenses := COALESCE(v_recompenses, 0);

  IF p_score_type = 'points' THEN
    v_new_score := GREATEST(0, COALESCE(v_current_points, 0) + p_delta);

    IF p_delta > 0 AND p_seuil > 0 THEN
      WHILE v_new_score >= p_seuil LOOP
        v_new_recompenses := v_new_recompenses + 1;
        v_new_score := v_new_score - p_seuil;
      END LOOP;
      v_final_score := LEAST(v_new_score, p_seuil);
    ELSE
      v_final_score := v_new_score;
    END IF;

    UPDATE public.clients
       SET points_actuels = v_final_score,
           recompenses_obtenues = v_new_recompenses,
           derniere_visite = now(),
           updated_at = now()
     WHERE id = p_client_id;

    RETURN json_build_object(
      'points_actuels', v_final_score,
      'tampons_actuels', v_current_tampons,
      'recompenses_obtenues', v_new_recompenses
    );
  ELSIF p_score_type = 'tampons' THEN
    v_new_score := GREATEST(0, COALESCE(v_current_tampons, 0) + p_delta);

    IF p_delta > 0 AND p_seuil > 0 AND v_new_score >= p_seuil THEN
      v_new_recompenses := v_new_recompenses + FLOOR(v_new_score::FLOAT / p_seuil)::INTEGER;
      v_final_score := v_new_score % p_seuil;
    ELSE
      v_final_score := v_new_score;
    END IF;

    UPDATE public.clients
       SET tampons_actuels = v_final_score,
           recompenses_obtenues = v_new_recompenses,
           derniere_visite = now(),
           updated_at = now()
     WHERE id = p_client_id;

    RETURN json_build_object(
      'points_actuels', v_current_points,
      'tampons_actuels', v_final_score,
      'recompenses_obtenues', v_new_recompenses
    );
  ELSE
    RAISE EXCEPTION 'score_type invalide : %', p_score_type;
  END IF;
END;
$$;

-- Fallback appele lors de l'achat de scanners.
CREATE OR REPLACE FUNCTION public.increment_scanners_count(commerce_id_input UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.commerces
     SET scanners_count = COALESCE(scanners_count, 0) + 1,
         updated_at = now()
   WHERE id = commerce_id_input;
END;
$$;

-- Durcit la fonction signalee par les advisors.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Backfill des commerces actifs/payes crees sans point de vente.
INSERT INTO public.points_vente (
  commerce_id,
  nom,
  adresse,
  latitude,
  longitude,
  rayon_geo,
  principal,
  actif
)
SELECT
  c.id,
  CONCAT(c.nom, ' - Principal'),
  c.adresse,
  c.latitude,
  c.longitude,
  COALESCE(c.rayon_geo, 1000),
  true,
  true
FROM public.commerces c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.points_vente pv
  WHERE pv.commerce_id = c.id
);

-- Index manquants signales par le linter.
CREATE INDEX IF NOT EXISTS idx_sms_logs_commerce ON public.sms_logs(commerce_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_client ON public.sms_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_sms_scheduled_commerce ON public.sms_scheduled(commerce_id);
CREATE INDEX IF NOT EXISTS idx_sms_scheduled_client ON public.sms_scheduled(client_id);
CREATE INDEX IF NOT EXISTS idx_admin_card_proposals_point_vente ON public.admin_card_proposals(point_vente_id);
CREATE INDEX IF NOT EXISTS idx_admin_card_proposals_carte ON public.admin_card_proposals(carte_id);
