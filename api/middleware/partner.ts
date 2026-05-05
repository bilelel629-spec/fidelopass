import type { Context, Next } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';

export type PartnerContext = {
  partner_user_id: string;
  partner_id: string;
  role: 'owner' | 'manager' | 'viewer';
  partner: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    included_commerces: number;
    monthly_price_cents: number;
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    support_email?: string | null;
    support_phone?: string | null;
    website_url?: string | null;
    custom_domain?: string | null;
    white_label_enabled?: boolean | null;
    hide_fidelopass_branding?: boolean | null;
    active?: boolean | null;
  };
};

export async function partnerMiddleware(c: Context, next: Next) {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Utilisateur non authentifié' }, 401);

  const db = createServiceClient();
  const { data, error } = await db
    .from('partner_users')
    .select('id, partner_id, role, active, partners(*)')
    .eq('user_id', userId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    const missingMigration = error.code === '42P01' || error.code === 'PGRST205' || /partner_users/i.test(error.message ?? '');
    if (missingMigration) {
      return c.json({ error: 'Module partenaire non initialisé. Exécutez la migration white label.' }, 503);
    }
    return c.json({ error: 'Impossible de vérifier l’accès partenaire.' }, 500);
  }

  const partner = Array.isArray(data?.partners) ? data?.partners[0] : data?.partners;
  if (!data || !partner || partner.active === false) {
    return c.json({ error: 'Accès réservé aux partenaires white label.' }, 403);
  }

  c.set('partnerContext', {
    partner_user_id: data.id,
    partner_id: data.partner_id,
    role: data.role,
    partner,
  } satisfies PartnerContext);

  await next();
}
