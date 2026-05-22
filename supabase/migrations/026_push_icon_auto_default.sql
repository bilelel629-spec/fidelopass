ALTER TABLE public.cartes
  ALTER COLUMN push_icon_bg_color DROP DEFAULT;

UPDATE public.cartes
SET push_icon_bg_color = NULL
WHERE lower(coalesce(push_icon_bg_color, '')) = '#6366f1';
