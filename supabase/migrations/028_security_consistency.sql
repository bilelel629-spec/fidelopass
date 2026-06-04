-- Consolidation securite/performance apres audit applicatif.
-- - Evite les full scans sur les graphiques et historiques par point de vente.
-- - Aligne le RPC d'ajustement manuel avec la logique applicative: le score
--   repart au reste quand un seuil de recompense est atteint.
-- - Rend explicite commerce_id sur review_rewards, deja utilise par l'API.

CREATE INDEX IF NOT EXISTS idx_transactions_point_vente_created_at
  ON public.transactions(point_vente_id, created_at DESC);

ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS commerce_id UUID REFERENCES public.commerces(id) ON DELETE CASCADE;

UPDATE public.review_rewards rr
   SET commerce_id = c.commerce_id
  FROM public.cartes c
 WHERE rr.carte_id = c.id
   AND rr.commerce_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_rewards_commerce
  ON public.review_rewards(commerce_id);

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
  v_safe_seuil INTEGER;
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

  v_safe_seuil := GREATEST(1, COALESCE(p_seuil, 1));
  v_new_recompenses := COALESCE(v_recompenses, 0);

  IF p_score_type = 'points' THEN
    v_new_score := COALESCE(v_current_points, 0);
    IF p_delta > 0 AND v_new_recompenses > 0 AND v_new_score >= v_safe_seuil THEN
      v_new_score := v_new_score % v_safe_seuil;
    END IF;
    v_new_score := GREATEST(0, v_new_score + p_delta);

    IF p_delta > 0 THEN
      v_new_recompenses := v_new_recompenses + FLOOR(v_new_score::NUMERIC / v_safe_seuil)::INTEGER;
      v_final_score := v_new_score % v_safe_seuil;
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
      'tampons_actuels', COALESCE(v_current_tampons, 0),
      'recompenses_obtenues', v_new_recompenses
    );
  ELSIF p_score_type = 'tampons' THEN
    v_new_score := COALESCE(v_current_tampons, 0);
    IF p_delta > 0 AND v_new_recompenses > 0 AND v_new_score >= v_safe_seuil THEN
      v_new_score := v_new_score % v_safe_seuil;
    END IF;
    v_new_score := GREATEST(0, v_new_score + p_delta);

    IF p_delta > 0 THEN
      v_new_recompenses := v_new_recompenses + FLOOR(v_new_score::NUMERIC / v_safe_seuil)::INTEGER;
      v_final_score := v_new_score % v_safe_seuil;
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
      'points_actuels', COALESCE(v_current_points, 0),
      'tampons_actuels', v_final_score,
      'recompenses_obtenues', v_new_recompenses
    );
  ELSE
    RAISE EXCEPTION 'score_type invalide : %', p_score_type;
  END IF;
END;
$$;
