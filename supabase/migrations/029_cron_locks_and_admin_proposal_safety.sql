-- Verrous applicatifs et garde-fous de concurrence.
-- - Evite les refresh Wallet dupliques quand plusieurs instances API tournent.
-- - Evite deux propositions admin ouvertes pour le meme commerce/point de vente.

CREATE TABLE IF NOT EXISTS public.cron_locks (
  name TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  locked_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role cron locks" ON public.cron_locks;
CREATE POLICY "service role cron locks" ON public.cron_locks
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cron_locks TO service_role;

CREATE OR REPLACE FUNCTION public.try_acquire_cron_lock(
  p_name TEXT,
  p_ttl_seconds INTEGER,
  p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_acquired BOOLEAN;
BEGIN
  INSERT INTO public.cron_locks(name, locked_until, locked_by, updated_at)
  VALUES (
    p_name,
    now() + make_interval(secs => GREATEST(5, COALESCE(p_ttl_seconds, 60))),
    p_owner,
    now()
  )
  ON CONFLICT (name) DO UPDATE
    SET locked_until = excluded.locked_until,
        locked_by = excluded.locked_by,
        updated_at = now()
  WHERE public.cron_locks.locked_until <= now()
     OR public.cron_locks.locked_by = excluded.locked_by
  RETURNING true INTO v_acquired;

  RETURN COALESCE(v_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cron_lock(
  p_name TEXT,
  p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_released BOOLEAN;
BEGIN
  UPDATE public.cron_locks
     SET locked_until = now() - interval '1 second',
         updated_at = now()
   WHERE name = p_name
     AND locked_by = p_owner
  RETURNING true INTO v_released;

  RETURN COALESCE(v_released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_cron_lock(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_cron_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_cron_lock(TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_cron_lock(TEXT, TEXT) TO service_role;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY commerce_id, point_vente_id
      ORDER BY updated_at DESC, created_at DESC
    ) AS rn
  FROM public.admin_card_proposals
  WHERE status IN ('draft_admin', 'pending_merchant')
)
UPDATE public.admin_card_proposals proposal
   SET status = 'archived_admin_duplicate',
       updated_at = now()
  FROM ranked
 WHERE proposal.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_card_proposals_one_open
  ON public.admin_card_proposals(commerce_id, point_vente_id)
  WHERE status IN ('draft_admin', 'pending_merchant');
