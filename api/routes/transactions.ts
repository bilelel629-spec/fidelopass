import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { updateGooglePassObject } from '../services/google-wallet';
import { pushApplePassUpdate } from '../services/apple-wallet';

export const transactionsRoutes = new Hono();

transactionsRoutes.use('*', authMiddleware);

const transactionSchema = z.object({
  client_id: z.string().uuid(),
  type: z.enum(['ajout_points', 'ajout_tampon', 'recompense', 'reset']),
  valeur: z.number().int().min(1).max(10000),
  note: z.string().max(255).nullable().optional(),
});

/** GET /api/transactions — Liste les transactions du commerce */
transactionsRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ data: [] });

  const { data, error } = await db
    .from('transactions')
    .select('*')
    .eq('commerce_id', commerce.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return c.json({ error: 'Erreur lors de la récupération' }, 500);

  return c.json({ data });
});

/** POST /api/transactions — Ajoute points ou tampons (via scanner) */
transactionsRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = transactionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();

  // Vérifie que le client appartient au commerce du commerçant connecté
  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('*, cartes(id, nom, type, tampons_total, points_recompense, recompense_description, couleur_fond, logo_url, strip_url, barcode_type, label_client, commerces(nom, logo_url))')
    .eq('id', parsed.data.client_id)
    .eq('commerce_id', commerce.id)
    .single();

  if (clientError || !client) return c.json({ error: 'Client introuvable' }, 404);

  const carte = (client as typeof client & { cartes: { type: string; tampons_total: number; points_recompense: number; [key: string]: unknown } }).cartes;
  const avantPoints = client.points_actuels;
  const avantTampons = client.tampons_actuels;

  let newPoints = avantPoints;
  let newTampons = avantTampons;
  let recompensesObtenues = client.recompenses_obtenues;

  switch (parsed.data.type) {
    case 'ajout_points':
      newPoints += parsed.data.valeur;
      if (newPoints >= carte.points_recompense) {
        recompensesObtenues += Math.floor(newPoints / carte.points_recompense);
        newPoints = newPoints % carte.points_recompense;
      }
      break;
    case 'ajout_tampon':
      newTampons += parsed.data.valeur;
      if (newTampons >= carte.tampons_total) {
        recompensesObtenues += Math.floor(newTampons / carte.tampons_total);
        newTampons = newTampons % carte.tampons_total;
      }
      break;
    case 'recompense':
      recompensesObtenues = Math.max(0, recompensesObtenues - parsed.data.valeur);
      break;
    case 'reset':
      newPoints = 0;
      newTampons = 0;
      break;
  }

  // Mise à jour client + création transaction en parallèle
  const [updateResult, transactionResult] = await Promise.all([
    db.from('clients').update({
      points_actuels: newPoints,
      tampons_actuels: newTampons,
      recompenses_obtenues: recompensesObtenues,
      derniere_visite: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', parsed.data.client_id),

    db.from('transactions').insert({
      client_id: parsed.data.client_id,
      commerce_id: commerce.id,
      type: parsed.data.type,
      valeur: parsed.data.valeur,
      points_avant: carte.type === 'points' ? avantPoints : avantTampons,
      points_apres: carte.type === 'points' ? newPoints : newTampons,
      note: parsed.data.note ?? null,
    }).select().single(),
  ]);

  if (updateResult.error || transactionResult.error) {
    return c.json({ error: 'Erreur lors de l\'enregistrement' }, 500);
  }

  if (client.google_pass_id) {
    updateGooglePassObject(
      client.google_pass_id,
      carte as Parameters<typeof updateGooglePassObject>[1],
      {
        ...client,
        points_actuels: newPoints,
        tampons_actuels: newTampons,
        recompenses_obtenues: recompensesObtenues,
      },
    ).catch((err) => console.error('[Google Wallet update]', err));
  }

  if (client.apple_pass_serial) {
    db.from('apple_pass_registrations')
      .select('push_token, pass_type_identifier')
      .eq('client_id', parsed.data.client_id)
      .then(({ data, error }) => {
        if (error) {
          console.error('[Apple Wallet registrations]', error);
          return;
        }

        for (const registration of data ?? []) {
          pushApplePassUpdate(registration.push_token, registration.pass_type_identifier)
            .catch((err) => console.error('[Apple Wallet push]', err));
        }
      });
  }

  return c.json({
    data: transactionResult.data,
    client: {
      points_actuels: newPoints,
      tampons_actuels: newTampons,
      recompenses_obtenues: recompensesObtenues,
    },
  }, 201);
});
