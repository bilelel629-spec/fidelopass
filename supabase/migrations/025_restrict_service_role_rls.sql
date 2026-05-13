-- Restreint les tables internes qui avaient des policies trop larges
-- (`USING (true) WITH CHECK (true)`) au rôle serveur Supabase uniquement.
DO $$
DECLARE
  target_table text;
  target_tables text[] := ARRAY[
    'review_rewards',
    'birthday_rewards',
    'stripe_webhook_events',
    'admin_audit_logs',
    'admin_card_proposals',
    'assistant_card_briefs',
    'partners',
    'partner_users'
  ];
BEGIN
  FOREACH target_table IN ARRAY target_tables LOOP
    IF to_regclass('public.' || quote_ident(target_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
      EXECUTE format('DROP POLICY IF EXISTS "service role full access" ON public.%I', target_table);
      EXECUTE format('DROP POLICY IF EXISTS "service role full access stripe webhook events" ON public.%I', target_table);
      EXECUTE format(
        'CREATE POLICY "service role full access" ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
        target_table
      );
    END IF;
  END LOOP;
END $$;
