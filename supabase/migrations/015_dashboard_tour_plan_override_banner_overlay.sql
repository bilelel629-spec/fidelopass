-- Plan override admin + tutoriel dashboard + filtre bannière

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

