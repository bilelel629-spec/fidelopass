ALTER TABLE public.cartes
ADD COLUMN IF NOT EXISTS tampon_icon_scale DOUBLE PRECISION DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cartes_tampon_icon_scale_check'
  ) THEN
    ALTER TABLE public.cartes
      ADD CONSTRAINT cartes_tampon_icon_scale_check
      CHECK (tampon_icon_scale >= 0.6 AND tampon_icon_scale <= 1.5);
  END IF;
END $$;
