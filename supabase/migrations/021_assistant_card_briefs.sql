CREATE TABLE IF NOT EXISTS public.assistant_card_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL REFERENCES public.commerces(id) ON DELETE CASCADE,
  point_vente_id UUID NOT NULL REFERENCES public.points_vente(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started',
  business_name TEXT,
  sector TEXT,
  desired_style TEXT,
  preferred_colors TEXT,
  reward_details TEXT,
  logo_url TEXT,
  inspiration_url TEXT,
  files JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  UNIQUE (commerce_id, point_vente_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assistant_card_briefs_status_check'
  ) THEN
    ALTER TABLE public.assistant_card_briefs
      ADD CONSTRAINT assistant_card_briefs_status_check
      CHECK (status IN (
        'not_started',
        'brief_received',
        'in_progress',
        'ready_for_review',
        'changes_requested',
        'approved',
        'published'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assistant_card_briefs_commerce
  ON public.assistant_card_briefs(commerce_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_card_briefs_point
  ON public.assistant_card_briefs(point_vente_id);

CREATE INDEX IF NOT EXISTS idx_assistant_card_briefs_status
  ON public.assistant_card_briefs(status, updated_at DESC);

ALTER TABLE public.assistant_card_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.assistant_card_briefs;
CREATE POLICY "service role full access"
ON public.assistant_card_briefs
USING (true)
WITH CHECK (true);
