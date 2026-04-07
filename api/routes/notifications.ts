import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { sendPushNotification } from '../services/push';

export const notificationsRoutes = new Hono();

notificationsRoutes.use('*', authMiddleware);

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

  // Récupère tous les clients avec push activé
  const { data: clients } = await db
    .from('clients')
    .select('id, fcm_token')
    .eq('commerce_id', commerce.id)
    .eq('push_enabled', true)
    .not('fcm_token', 'is', null);

  const tokens = (clients ?? [])
    .map((c) => c.fcm_token)
    .filter((t): t is string => !!t);

  let nbDelivrees = 0;
  if (tokens.length > 0) {
    nbDelivrees = await sendPushNotification(tokens, parsed.data.titre, parsed.data.message);
  }

  // Enregistre la notification
  const { data: notif } = await db
    .from('notifications')
    .insert({
      commerce_id: commerce.id,
      titre: parsed.data.titre,
      message: parsed.data.message,
      type: parsed.data.type,
      nb_destinataires: tokens.length,
      nb_delivrees: nbDelivrees,
    })
    .select()
    .single();

  return c.json({ data: notif, nb_destinataires: tokens.length, nb_delivrees: nbDelivrees }, 201);
});
