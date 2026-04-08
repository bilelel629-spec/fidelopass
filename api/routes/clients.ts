import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';

export const clientsRoutes = new Hono();

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

/** GET /api/clients/public/:id — État minimal du client pour la page carte publique */
clientsRoutes.get('/public/:id', async (c) => {
  const clientId = c.req.param('id');
  const carteId = c.req.query('carte_id');
  const db = createServiceClient();

  const { data, error } = await db
    .from('clients')
    .select(`
      id,
      nom,
      telephone,
      carte_id,
      points_actuels,
      tampons_actuels,
      recompenses_obtenues,
      cartes(
        id,
        actif,
        type,
        tampons_total,
        points_recompense,
        recompense_description
      )
    `)
    .eq('id', clientId)
    .single();

  if (error || !data) return c.json({ error: 'Client introuvable' }, 404);
  if (carteId && data.carte_id !== carteId) return c.json({ error: 'Client introuvable' }, 404);

  const carte = Array.isArray(data.cartes) ? data.cartes[0] : data.cartes;
  if (!carte?.actif) return c.json({ error: 'Carte introuvable' }, 404);

  return c.json({
    data: {
      id: data.id,
      nom: data.nom,
      telephone: data.telephone,
      points_actuels: data.points_actuels,
      tampons_actuels: data.tampons_actuels,
      recompenses_obtenues: data.recompenses_obtenues,
      carte: {
        id: carte.id,
        type: carte.type,
        tampons_total: carte.tampons_total,
        points_recompense: carte.points_recompense,
        recompense_description: carte.recompense_description,
      },
    },
  });
});

/** GET /api/clients/:id — Récupère un client (utilisé par le scanner) */
clientsRoutes.get('/:id', authMiddleware, async (c) => {
  const clientId = c.req.param('id');
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data, error } = await db
    .from('clients')
    .select('*, cartes(nom, type, tampons_total, points_recompense)')
    .eq('id', clientId)
    .eq('commerce_id', commerce.id)
    .single();

  if (error || !data) return c.json({ error: 'Client introuvable' }, 404);

  return c.json({ data });
});

/** GET /api/clients — Liste les clients du commerce */
clientsRoutes.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const search = c.req.query('search') ?? '';
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ data: [] });

  let query = db
    .from('clients')
    .select('*')
    .eq('commerce_id', commerce.id)
    .order('derniere_visite', { ascending: false, nullsFirst: false });

  if (search) {
    query = query.or(`nom.ilike.%${search}%,email.ilike.%${search}%,telephone.ilike.%${search}%`);
  }

  const { data, error } = await query.limit(100);
  if (error) return c.json({ error: 'Erreur lors de la récupération' }, 500);

  return c.json({ data });
});

/** POST /api/clients — Crée un client (lors de l'ajout au Wallet) */
clientsRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    carte_id: z.string().uuid(),
    nom: z.string().min(1, 'Le prénom est obligatoire').max(255),
    telephone: z.string().min(8, 'Le numéro de téléphone est obligatoire').max(20),
    email: z.string().email().nullable().optional(),
    push_consent: z.boolean().default(false),
    fcm_token: z.string().nullable().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const normalizedPhone = normalizePhone(parsed.data.telephone);

  const { data: carte } = await db
    .from('cartes')
    .select('commerce_id')
    .eq('id', parsed.data.carte_id)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  const { data: existingClient, error: existingClientError } = await db
    .from('clients')
    .select('*')
    .eq('carte_id', parsed.data.carte_id)
    .eq('commerce_id', carte.commerce_id)
    .eq('telephone', normalizedPhone)
    .maybeSingle();

  if (existingClientError) {
    return c.json({ error: 'Erreur lors de la vérification du client' }, 500);
  }

  if (existingClient) {
    const nextFcmToken = parsed.data.fcm_token ?? existingClient.fcm_token;
    const pushEnabled = Boolean(nextFcmToken) && (parsed.data.push_consent || existingClient.push_enabled);

    const { data: updatedClient, error: updateError } = await db
      .from('clients')
      .update({
        nom: parsed.data.nom,
        telephone: normalizedPhone,
        email: parsed.data.email ?? existingClient.email,
        fcm_token: nextFcmToken,
        push_enabled: pushEnabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingClient.id)
      .select()
      .single();

    if (updateError || !updatedClient) {
      return c.json({ error: 'Erreur lors de la mise à jour du client' }, 500);
    }

    return c.json({ data: updatedClient, existing: true });
  }

  const { data, error } = await db
    .from('clients')
    .insert({
      carte_id: parsed.data.carte_id,
      commerce_id: carte.commerce_id,
      nom: parsed.data.nom,
      telephone: normalizedPhone,
      email: parsed.data.email ?? null,
      fcm_token: parsed.data.fcm_token ?? null,
      push_enabled: parsed.data.push_consent && Boolean(parsed.data.fcm_token),
    })
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la création du client' }, 500);

  return c.json({ data }, 201);
});

/** PATCH /api/clients/:id/fcm — Met à jour le token FCM */
clientsRoutes.patch('/:id/fcm', async (c) => {
  const clientId = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  const schema = z.object({ fcm_token: z.string() });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Token FCM invalide' }, 400);

  const db = createServiceClient();
  const { error } = await db
    .from('clients')
    .update({ fcm_token: parsed.data.fcm_token, push_enabled: true })
    .eq('id', clientId);

  if (error) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);

  return c.json({ ok: true });
});
