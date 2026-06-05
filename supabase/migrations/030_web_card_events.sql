-- Journal discret des ouvertures de carte web.
-- Utilise uniquement l'API service-role: aucune politique publique de lecture/ecriture.

CREATE TABLE IF NOT EXISTS public.web_card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  carte_id UUID NOT NULL REFERENCES public.cartes(id) ON DELETE CASCADE,
  commerce_id UUID NOT NULL REFERENCES public.commerces(id) ON DELETE CASCADE,
  point_vente_id UUID REFERENCES public.points_vente(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL DEFAULT 'opened' CHECK (event_type IN ('opened')),
  user_agent TEXT,
  referrer TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_card_events_carte_opened
  ON public.web_card_events(carte_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_card_events_commerce_point_opened
  ON public.web_card_events(commerce_id, point_vente_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_card_events_client_opened
  ON public.web_card_events(client_id, opened_at DESC);

ALTER TABLE public.web_card_events ENABLE ROW LEVEL SECURITY;
