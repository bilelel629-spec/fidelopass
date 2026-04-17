import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { sendSMS, personnaliserMessage } from '../../src/lib/brevo-sms';

export const smsRoutes = new Hono();

smsRoutes.use('*', authMiddleware);
smsRoutes.use('*', paidMiddleware);

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

/** GET /api/sms/stats — Solde + historique */
smsRoutes.get('/stats', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id, sms_credits, sms_welcome_enabled, sms_welcome_message, sms_review_enabled, sms_relance_enabled, sms_relance_jours')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: logs } = await db
    .from('sms_logs')
    .select('*')
    .eq('commerce_id', commerce.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);

  const { count: clientsCount } = await db
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('commerce_id', commerce.id)
    .not('telephone', 'is', null);

  return c.json({
    data: {
      sms_credits: commerce.sms_credits ?? 0,
      sms_welcome_enabled: commerce.sms_welcome_enabled ?? false,
      sms_welcome_message: commerce.sms_welcome_message ?? null,
      sms_review_enabled: commerce.sms_review_enabled ?? false,
      sms_relance_enabled: commerce.sms_relance_enabled ?? false,
      sms_relance_jours: commerce.sms_relance_jours ?? 30,
      logs: logs ?? [],
      clients_avec_telephone: clientsCount ?? 0,
    },
  });
});

/** PATCH /api/sms/settings — Paramètres SMS automatiques */
smsRoutes.patch('/settings', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    sms_welcome_enabled: z.boolean().optional(),
    sms_welcome_message: z.string().max(160).nullable().optional(),
    sms_review_enabled: z.boolean().optional(),
    sms_relance_enabled: z.boolean().optional(),
    sms_relance_jours: z.number().int().min(1).max(365).optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);

  const db = createServiceClient();
  const { data: commerce } = await db.from('commerces').select('id').eq('user_id', userId).single();
  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { error } = await db.from('commerces').update(parsed.data).eq('id', commerce.id);
  if (error) return c.json({ error: 'Erreur mise à jour' }, 500);

  return c.json({ ok: true });
});

/** POST /api/sms/campagne — Campagne SMS manuelle */
smsRoutes.post('/campagne', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    filtre: z.enum(['tous', 'sans_avis', 'inactifs']).default('tous'),
    inactifs_jours: z.number().int().min(1).max(365).optional(),
    message: z.string().min(1).max(160),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);

  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id, nom, sms_credits')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);
  if ((commerce.sms_credits ?? 0) === 0) {
    return c.json({ error: 'Crédits SMS épuisés. Rechargez votre solde.' }, 402);
  }

  // Récupère la carte active pour le lien avis
  const { data: carte } = await db
    .from('cartes')
    .select('id, google_maps_url')
    .eq('commerce_id', commerce.id)
    .eq('actif', true)
    .maybeSingle();

  // Filtre des clients
  let query = db
    .from('clients')
    .select('id, nom, telephone')
    .eq('commerce_id', commerce.id)
    .not('telephone', 'is', null);

  if (parsed.data.filtre === 'sans_avis' && carte) {
    const { data: claimed } = await db
      .from('review_rewards')
      .select('client_id')
      .eq('carte_id', carte.id);
    const claimedIds = (claimed ?? []).map((r) => r.client_id);
    if (claimedIds.length > 0) {
      query = query.not('id', 'in', `(${claimedIds.join(',')})`);
    }
  } else if (parsed.data.filtre === 'inactifs') {
    const jours = parsed.data.inactifs_jours ?? 30;
    const cutoff = new Date(Date.now() - jours * 24 * 60 * 60 * 1000).toISOString();
    query = query.or(`derniere_visite.is.null,derniere_visite.lte.${cutoff}`);
  }

  const { data: clients } = await query.limit(commerce.sms_credits ?? 0);

  if (!clients || clients.length === 0) {
    return c.json({ message: 'Aucun client correspondant à ce filtre.', envoyes: 0, echecs: 0 });
  }

  const lienAvis = carte?.google_maps_url ?? '';
  let envoyes = 0;
  let echecs = 0;

  for (const client of clients) {
    if (!client.telephone) continue;

    const msg = personnaliserMessage(parsed.data.message, {
      prenom: client.nom ?? '',
      commerce: commerce.nom ?? '',
      lien_avis: lienAvis,
      lien_carte: carte ? `${PUBLIC_SITE_URL}/carte/${carte.id}` : '',
    });

    const result = await sendSMS(client.telephone, msg, commerce.id, client.id, 'campagne');
    if (result.success) envoyes++;
    else echecs++;
  }

  // Relit les crédits restants
  const { data: updated } = await db.from('commerces').select('sms_credits').eq('id', commerce.id).single();

  return c.json({
    envoyes,
    echecs,
    credits_restants: updated?.sms_credits ?? 0,
  }, 201);
});

/** GET /api/sms/preview — Nombre de destinataires pour un filtre */
smsRoutes.get('/preview', async (c) => {
  const userId = c.get('userId') as string;
  const filtre = c.req.query('filtre') ?? 'tous';
  const inactifsJours = parseInt(c.req.query('inactifs_jours') ?? '30');
  const db = createServiceClient();

  const { data: commerce } = await db.from('commerces').select('id').eq('user_id', userId).single();
  if (!commerce) return c.json({ count: 0 });

  const { data: carte } = await db
    .from('cartes').select('id').eq('commerce_id', commerce.id).eq('actif', true).maybeSingle();

  let query = db
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('commerce_id', commerce.id)
    .not('telephone', 'is', null);

  if (filtre === 'sans_avis' && carte) {
    const { data: claimed } = await db.from('review_rewards').select('client_id').eq('carte_id', carte.id);
    const ids = (claimed ?? []).map((r) => r.client_id);
    if (ids.length > 0) query = query.not('id', 'in', `(${ids.join(',')})`);
  } else if (filtre === 'inactifs') {
    const cutoff = new Date(Date.now() - inactifsJours * 24 * 60 * 60 * 1000).toISOString();
    query = query.or(`derniere_visite.is.null,derniere_visite.lte.${cutoff}`);
  }

  const { count } = await query;
  return c.json({ count: count ?? 0 });
});
