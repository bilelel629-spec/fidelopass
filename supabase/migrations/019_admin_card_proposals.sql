CREATE TABLE IF NOT EXISTS public.admin_card_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL REFERENCES public.commerces(id) ON DELETE CASCADE,
  point_vente_id UUID NOT NULL REFERENCES public.points_vente(id) ON DELETE CASCADE,
  carte_id UUID REFERENCES public.cartes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft_admin',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  admin_note TEXT,
  created_by_admin_user_id UUID NOT NULL,
  created_by_admin_email TEXT,
  reviewed_by_user_id UUID,
  merchant_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_card_proposals_commerce_point
  ON public.admin_card_proposals(commerce_id, point_vente_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_card_proposals_status
  ON public.admin_card_proposals(status);

CREATE INDEX IF NOT EXISTS idx_admin_card_proposals_updated_at
  ON public.admin_card_proposals(updated_at DESC);

ALTER TABLE public.admin_card_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.admin_card_proposals;
CREATE POLICY "service role full access" ON public.admin_card_proposals
  USING (true)
  WITH CHECK (true);
