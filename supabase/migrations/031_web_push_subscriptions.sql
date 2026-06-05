-- Abonnements Web Push natifs pour les cartes web Fidelopass.
-- Stockage service-role uniquement: les clients passent par l'API FideloPass.

CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  carte_id UUID NOT NULL REFERENCES public.cartes(id) ON DELETE CASCADE,
  commerce_id UUID NOT NULL REFERENCES public.commerces(id) ON DELETE CASCADE,
  point_vente_id UUID REFERENCES public.points_vente(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_client
  ON public.web_push_subscriptions(client_id)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_commerce_point
  ON public.web_push_subscriptions(commerce_id, point_vente_id)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_carte
  ON public.web_push_subscriptions(carte_id)
  WHERE enabled = true;

ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;
