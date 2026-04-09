import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { sendPushNotification } from '../services/push';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { sendGoogleWalletMessage } from '../services/google-wallet';

export const notificationsRoutes = new Hono();

notificationsRoutes.use('*', authMiddleware);

/** GET /api/notifications/summary — Résumé des canaux réellement disponibles */
notificationsRoutes.get('/summary', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) {
    return c.json({
      data: {
        web_push_ready: 0,
        wallet_ready: 0,
      },
    });
  }

  const [{ count: webPushReady }, { data: clients }] = await Promise.all([
    db
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id)
      .eq('push_enabled', true)
      .not('fcm_token', 'is', null),
    db
      .from('clients')
      .select('id, apple_pass_serial, google_pass_id')
      .eq('commerce_id', commerce.id),
  ]);

  const walletReady = (clients ?? []).filter((client) => client.apple_pass_serial || client.google_pass_id).length;

  return c.json({
    data: {
      web_push_ready: webPushReady ?? 0,
      wallet_ready: walletReady,
    },
  });
});

/** GET /api/notifications — Historique des notifications */
notificationsRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100);
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ data: [] });

  const { data } = await db
    .from('notifications')
    .select('*')
    .eq('commerce_id', commerce.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  return c.json({ data: data ?? [] });
});

/** POST /api/notifications — Envoie une notification à tous les clients */
notificationsRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    titre: z.string().min(1).max(50),
    message: z.string().min(1).max(150),
    type: z.enum(['promo', 'info', 'urgence']).default('promo'),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  // Récupère les clients joignables par web push ou Wallet
  const { data: clients } = await db
    .from('clients')
    .select('id, fcm_token, push_enabled, google_pass_id, apple_pass_serial')
    .eq('commerce_id', commerce.id)
    .order('created_at', { ascending: false });

  const webPushClients = (clients ?? [])
    .filter((client) => client.push_enabled && client.fcm_token);

  const tokens = webPushClients
    .map((client) => client.fcm_token)
    .filter((t): t is string => !!t);

  const googleWalletClients = (clients ?? []).filter((client) => !!client.google_pass_id);
  const appleWalletClients = (clients ?? []).filter((client) => !!client.apple_pass_serial);

  const targetedClientIds = new Set<string>([
    ...webPushClients.map((client) => client.id),
    ...googleWalletClients.map((client) => client.id),
    ...appleWalletClients.map((client) => client.id),
  ]);

  const { data: notif, error: notifInsertError } = await db
    .from('notifications')
    .insert({
      commerce_id: commerce.id,
      titre: parsed.data.titre,
      message: parsed.data.message,
      type: parsed.data.type,
      nb_destinataires: targetedClientIds.size,
      nb_delivrees: 0,
    })
    .select()
    .single();

  if (notifInsertError || !notif) {
    console.error('[notifications insert]', notifInsertError);
    return c.json({ error: 'Impossible d’enregistrer le message avant envoi.' }, 500);
  }

  let nbDelivreesWeb = 0;
  const walletDeliveredClientIds = new Set<string>();

  if (tokens.length > 0) {
    try {
      nbDelivreesWeb = await sendPushNotification(tokens, parsed.data.titre, parsed.data.message);
    } catch (err) {
      console.error('[notifications push]', err);
    }
  }

  if (googleWalletClients.length > 0) {
    const results = await Promise.allSettled(
      googleWalletClients.map(async (client) => {
        await sendGoogleWalletMessage(
          client.google_pass_id as string,
          parsed.data.titre,
          parsed.data.message,
          notif.id,
        );
        walletDeliveredClientIds.add(client.id);
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[notifications wallet google]', result.reason);
      }
    }
  }

  if (appleWalletClients.length > 0) {
    const appleClientIds = appleWalletClients.map((client) => client.id);
    const { data: registrations, error: registrationsError } = await db
      .from('apple_pass_registrations')
      .select('client_id, push_token, pass_type_identifier')
      .in('client_id', appleClientIds);

    if (registrationsError) {
      console.error('[notifications wallet apple registrations]', registrationsError);
    } else {
      const appleResults = await Promise.allSettled(
        (registrations ?? []).map(async (registration) => {
          await pushApplePassUpdate(registration.push_token, registration.pass_type_identifier);
          walletDeliveredClientIds.add(registration.client_id);
        }),
      );

      for (const result of appleResults) {
        if (result.status === 'rejected') {
          console.error('[notifications wallet apple]', result.reason);
        }
      }
    }
  }

  const deliveredClientIds = new Set<string>();
  if (nbDelivreesWeb > 0) {
    webPushClients.slice(0, nbDelivreesWeb).forEach((client) => deliveredClientIds.add(client.id));
  }
  walletDeliveredClientIds.forEach((id) => deliveredClientIds.add(id));

  const nbDestinataires = targetedClientIds.size;
  const nbDelivrees = deliveredClientIds.size;

  const { data: updatedNotif } = await db
    .from('notifications')
    .update({
      nb_destinataires: nbDestinataires,
      nb_delivrees: nbDelivrees,
    })
    .eq('id', notif.id)
    .select()
    .single();

  return c.json({
    data: updatedNotif ?? notif,
    nb_destinataires: nbDestinataires,
    nb_delivrees: nbDelivrees,
    nb_wallet: walletDeliveredClientIds.size,
    nb_web_push: nbDelivreesWeb,
  }, 201);
});
