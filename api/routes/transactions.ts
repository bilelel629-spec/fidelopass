import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { updateGooglePassObject } from '../services/google-wallet';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { sendPushNotification } from '../services/push';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';

export const transactionsRoutes = new Hono();

transactionsRoutes.use('*', authMiddleware);
transactionsRoutes.use('*', paidMiddleware);

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
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ data: [] });

  const { data, error } = await db
    .from('transactions')
    .select('*')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
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
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();

  // Vérifie que le client appartient au commerce du commerçant connecté
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('*, cartes(id, nom, type, tampons_total, points_recompense, recompense_description, couleur_fond, logo_url, strip_url, barcode_type, label_client, commerces(nom, logo_url))')
    .eq('id', parsed.data.client_id)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
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
        // Plafonne au seuil — le reset se fait quand le commerçant attribue la récompense
        newPoints = carte.points_recompense;
      }
      break;
    case 'ajout_tampon':
      newTampons += parsed.data.valeur;
      if (newTampons >= carte.tampons_total) {
        recompensesObtenues += Math.floor(newTampons / carte.tampons_total);
        // Plafonne au seuil — le reset se fait quand le commerçant attribue la récompense
        newTampons = carte.tampons_total;
      }
      break;
    case 'recompense':
      // Reset du score + décrémentation de la récompense quand le commerçant l'attribue
      recompensesObtenues = Math.max(0, recompensesObtenues - parsed.data.valeur);
      if (carte.type === 'tampons') newTampons = 0;
      else newPoints = 0;
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
      point_vente_id: pointVente.id,
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

  // Push notification client (fire-and-forget)
  const rewardJustEarned = recompensesObtenues > client.recompenses_obtenues;
  const rewardJustUsed = parsed.data.type === 'recompense';
  const clientFcmToken = (client as { fcm_token?: string | null }).fcm_token;
  const clientPushEnabled = (client as { push_enabled?: boolean }).push_enabled;

  if (clientPushEnabled && clientFcmToken) {
    const carteTyped = carte as { recompense_description?: string; commerces?: { nom?: string } };
    if (rewardJustEarned) {
      const desc = carteTyped.recompense_description ?? 'votre récompense';
      sendPushNotification(
        [clientFcmToken],
        '🎉 Récompense disponible !',
        `Félicitations ! Vous pouvez maintenant bénéficier de votre récompense : ${desc}. Montrez votre carte au commerce.`,
      ).catch((err) => console.error('[push reward earned]', err));
    } else if (rewardJustUsed) {
      const carteNom = (carte as { nom?: string | null }).nom ?? carteTyped.commerces?.nom ?? 'votre carte';
      sendPushNotification(
        [clientFcmToken],
        '✅ Récompense attribuée !',
        `Votre récompense a été attribuée sur ${carteNom}. Merci de votre fidélité.`,
      ).catch((err) => console.error('[push reward used]', err));
    }
  }

  const walletUpdates: Array<Promise<{ provider: string; ok: boolean; count?: number; error?: string }>> = [];
  const updatedClient = {
    ...client,
    points_actuels: newPoints,
    tampons_actuels: newTampons,
    recompenses_obtenues: recompensesObtenues,
  };

  if (client.google_pass_id) {
    walletUpdates.push(
      updateGooglePassObject(
        client.google_pass_id,
        carte as Parameters<typeof updateGooglePassObject>[1],
        updatedClient,
      )
        .then(() => ({ provider: 'google', ok: true }))
        .catch((err) => {
          console.error('[Google Wallet update]', err);
          return { provider: 'google', ok: false, error: err instanceof Error ? err.message : 'Google update failed' };
        }),
    );
  }

  if (client.apple_pass_serial) {
    walletUpdates.push(
      db.from('apple_pass_registrations')
      .select('push_token, pass_type_identifier')
      .eq('client_id', parsed.data.client_id)
      .then(({ data, error }) => {
        if (error) {
          console.error('[Apple Wallet registrations]', error);
          return { provider: 'apple', ok: false, count: 0, error: error.message };
        }

        const registrations = data ?? [];
        const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
        const uniqueRegistrations = Array.from(
          new Map(registrations.map((registration) => [registration.push_token, registration])).values(),
        );
        return Promise.allSettled(
          uniqueRegistrations.map((registration) =>
            pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
          ),
        ).then((results) => {
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) {
            console.error('[Apple Wallet push]', failed.reason);
          }
          return { provider: 'apple', ok: !failed, count: registrations.length };
        });
      }),
    );
  }

  const wallet_update_results = await Promise.all(walletUpdates);

  return c.json({
    data: transactionResult.data,
    client: {
      points_actuels: newPoints,
      tampons_actuels: newTampons,
      recompenses_obtenues: recompensesObtenues,
    },
    wallet_update_results,
  }, 201);
});
