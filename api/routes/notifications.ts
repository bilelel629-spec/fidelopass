import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { getPlanLimits, normalizePlan } from './commerces';
import { sendPushNotification, sendPersonalizedPushNotifications } from '../services/push';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { sendGoogleWalletMessage } from '../services/google-wallet';
import { sendSMS, personnaliserMessage } from '../../src/lib/brevo-sms';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

const PUBLIC_SITE_URL_NOTIF = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
const BIRTHDAY_TIMEZONE = 'Europe/Paris';
const BIRTHDAY_SEND_HOUR = 10;
const DEFAULT_BIRTHDAY_PUSH_TITLE = 'Joyeux anniversaire 🎉';
const DEFAULT_BIRTHDAY_PUSH_MESSAGE = 'Votre bonus anniversaire est disponible sur votre carte Fidelopass.';

async function resolveScopedCarteIdsForPoint(
  db: ReturnType<typeof createServiceClient>,
  commerceId: string,
  pointVenteId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  const { data: pointCards } = await db
    .from('cartes')
    .select('id')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId);

  for (const card of pointCards ?? []) {
    if (card?.id) ids.add(card.id);
  }

  const { data: clientCards } = await db
    .from('clients')
    .select('carte_id')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId)
    .not('carte_id', 'is', null);

  for (const row of clientCards ?? []) {
    const carteId = (row as { carte_id?: string | null })?.carte_id;
    if (carteId) ids.add(carteId);
  }

  return Array.from(ids);
}

export const notificationsRoutes = new Hono();

notificationsRoutes.use('*', authMiddleware);
notificationsRoutes.use('*', paidMiddleware);

type CommerceFlags = {
  review_auto_enabled?: boolean | null;
  sms_review_enabled?: boolean | null;
  sms_credits?: number | null;
};

type BirthdaySettingsRow = {
  id: string;
  birthday_auto_enabled?: boolean | null;
  birthday_reward_value?: number | null;
  birthday_push_title?: string | null;
  birthday_push_message?: string | null;
};

function getReviewAutoEnabled(flags: CommerceFlags | null): boolean {
  if (!flags) return false;
  return Boolean(flags.review_auto_enabled ?? flags.sms_review_enabled ?? false);
}

async function loadCommerceFlags(db: ReturnType<typeof createServiceClient>, commerceId: string): Promise<CommerceFlags | null> {
  const { data, error } = await db
    .from('commerces')
    .select('*')
    .eq('id', commerceId)
    .maybeSingle();

  if (error || !data) return null;
  return data as CommerceFlags;
}

async function persistReviewAutoEnabled(
  db: ReturnType<typeof createServiceClient>,
  commerceId: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const attempts: Array<Record<string, unknown>> = [
    { review_auto_enabled: enabled, sms_review_enabled: enabled },
    { review_auto_enabled: enabled },
    { sms_review_enabled: enabled },
  ];

  let lastErrorMessage = 'Impossible de mettre à jour le réglage.';

  for (const patch of attempts) {
    const { error } = await db
      .from('commerces')
      .update(patch)
      .eq('id', commerceId);

    if (!error) return { ok: true };

    lastErrorMessage = error.message ?? lastErrorMessage;
    const isUnknownColumn =
      /column/i.test(lastErrorMessage)
      || /does not exist/i.test(lastErrorMessage)
      || /schema cache/i.test(lastErrorMessage);

    if (!isUnknownColumn) break;
  }

  return { ok: false, message: lastErrorMessage };
}

function getBirthdayDefaultMessage(carteName?: string | null): string {
  if (!carteName) return DEFAULT_BIRTHDAY_PUSH_MESSAGE;
  return `Votre bonus anniversaire est disponible sur ${carteName}.`;
}

/** GET /api/notifications/review-reminder-settings — Réglage push auto avis Google (+1h) */
notificationsRoutes.get('/review-reminder-settings', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const flags = await loadCommerceFlags(db, commerce.id);
  const effectivePlan = getEffectivePlanRaw(commerce);
  const planLimits = getPlanLimits(effectivePlan);
  const normalizedPlan = normalizePlan(effectivePlan);
  return c.json({
    data: {
      enabled: getReviewAutoEnabled(flags),
      plan: normalizedPlan,
      raw_plan: commerce.plan ?? 'starter',
      plan_override: commerce.plan_override ?? null,
      is_pro: Boolean(planLimits.avisGoogle),
      delay_minutes: 60,
    },
  });
});

/** PATCH /api/notifications/review-reminder-settings — Active/désactive le push auto avis Google (+1h) */
notificationsRoutes.patch('/review-reminder-settings', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan, plan_override');

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const planLimits = getPlanLimits(getEffectivePlanRaw(commerce));
  if (!planLimits.avisGoogle) {
    return c.json({ error: 'Cette automatisation est réservée au plan Pro.' }, 403);
  }

  const writeResult = await persistReviewAutoEnabled(db, commerce.id, parsed.data.enabled);
  if (!writeResult.ok) {
    return c.json({
      error: `Impossible de mettre à jour le réglage (${writeResult.message}). Vérifiez que les migrations Supabase sont bien à jour.`,
    }, 500);
  }

  return c.json({ ok: true, data: { enabled: parsed.data.enabled, delay_minutes: 60 } });
});

/** GET /api/notifications/birthday-settings — Réglage auto anniversaire (jour J à 10h) */
notificationsRoutes.get('/birthday-settings', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const effectivePlan = getEffectivePlanRaw(commerce);
  const planLimits = getPlanLimits(effectivePlan);
  const normalizedPlan = normalizePlan(effectivePlan);

  let carte: Record<string, unknown> | null = null;
  const birthdaySelect = await db
    .from('cartes')
    .select('id, nom, birthday_auto_enabled, birthday_reward_value, birthday_push_title, birthday_push_message')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('actif', true)
    .maybeSingle();

  if (birthdaySelect.error && /column|does not exist|schema cache/i.test(birthdaySelect.error.message ?? '')) {
    const fallback = await db
      .from('cartes')
      .select('id, nom')
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .eq('actif', true)
      .maybeSingle();
    carte = (fallback.data as Record<string, unknown> | null) ?? null;
  } else {
    carte = (birthdaySelect.data as Record<string, unknown> | null) ?? null;
  }

  const row = (carte ?? null) as BirthdaySettingsRow | null;
  const defaultMessage = getBirthdayDefaultMessage((carte as { nom?: string | null } | null)?.nom ?? null);

  return c.json({
    data: {
      enabled: Boolean(row?.birthday_auto_enabled ?? false),
      reward_value: Number(row?.birthday_reward_value ?? 1),
      push_title: row?.birthday_push_title ?? DEFAULT_BIRTHDAY_PUSH_TITLE,
      push_message: row?.birthday_push_message ?? defaultMessage,
      plan: normalizedPlan,
      raw_plan: commerce.plan ?? 'starter',
      plan_override: commerce.plan_override ?? null,
      is_pro: Boolean(planLimits.anniversaire),
      schedule: {
        timezone: BIRTHDAY_TIMEZONE,
        hour: BIRTHDAY_SEND_HOUR,
      },
      has_active_card: Boolean(carte),
    },
  });
});

/** PATCH /api/notifications/birthday-settings — Active/désactive + configure anniversaire */
notificationsRoutes.patch('/birthday-settings', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const schema = z.object({
    enabled: z.boolean().optional(),
    reward_value: z.number().int().min(1).max(50).optional(),
    push_title: z.string().max(80).nullable().optional(),
    push_message: z.string().max(180).nullable().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'Aucune donnée à mettre à jour.',
  });
  const parsed = schema.safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const planLimits = getPlanLimits(getEffectivePlanRaw(commerce));
  if (!planLimits.anniversaire) {
    return c.json({ error: 'Cette automatisation est réservée au plan Pro.' }, 403);
  }

  const cardRead = await db
    .from('cartes')
    .select('id, nom, birthday_reward_value')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('actif', true)
    .maybeSingle();

  let carte = cardRead.data as ({ id: string; nom?: string | null; birthday_reward_value?: number | null } | null);
  if (!carte && cardRead.error && /column|does not exist|schema cache/i.test(cardRead.error.message ?? '')) {
    const fallback = await db
      .from('cartes')
      .select('id, nom')
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .eq('actif', true)
      .maybeSingle();
    carte = fallback.data as ({ id: string; nom?: string | null; birthday_reward_value?: number | null } | null);
  }

  if (!carte) {
    return c.json({ error: 'Aucune carte active sur ce point de vente.' }, 404);
  }

  const nextTitle = parsed.data.push_title === undefined
    ? undefined
    : (parsed.data.push_title ?? DEFAULT_BIRTHDAY_PUSH_TITLE);
  const nextMessage = parsed.data.push_message === undefined
    ? undefined
    : (parsed.data.push_message ?? getBirthdayDefaultMessage((carte as { nom?: string | null }).nom ?? null));
  const nextRewardValue = parsed.data.reward_value ?? (carte as { birthday_reward_value?: number | null }).birthday_reward_value ?? 1;

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.enabled !== undefined) payload.birthday_auto_enabled = parsed.data.enabled;
  if (nextRewardValue !== undefined) payload.birthday_reward_value = nextRewardValue;
  if (nextTitle !== undefined) payload.birthday_push_title = nextTitle;
  if (nextMessage !== undefined) payload.birthday_push_message = nextMessage;

  const { data: updated, error: updateError } = await db
    .from('cartes')
    .update(payload)
    .eq('id', carte.id)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .select('birthday_auto_enabled, birthday_reward_value, birthday_push_title, birthday_push_message')
    .single();

  if (updateError) {
    const updateMessage = updateError.message ?? 'Impossible de mettre à jour le réglage anniversaire.';
    if (/column|does not exist|schema cache/i.test(updateMessage)) {
      return c.json({
        error: `Impossible de mettre à jour le réglage anniversaire (${updateMessage}). Vérifiez que la migration Supabase 014 est bien appliquée.`,
      }, 500);
    }
    return c.json({ error: updateMessage }, 500);
  }

  return c.json({
    ok: true,
    data: {
      enabled: Boolean(updated?.birthday_auto_enabled ?? false),
      reward_value: Number(updated?.birthday_reward_value ?? 1),
      push_title: updated?.birthday_push_title ?? DEFAULT_BIRTHDAY_PUSH_TITLE,
      push_message: updated?.birthday_push_message ?? getBirthdayDefaultMessage((carte as { nom?: string | null }).nom ?? null),
      schedule: {
        timezone: BIRTHDAY_TIMEZONE,
        hour: BIRTHDAY_SEND_HOUR,
      },
    },
  });
});

/** GET /api/notifications/push-icon-settings — Couleur de fond du logo push */
notificationsRoutes.get('/push-icon-settings', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const scopedCarteIds = await resolveScopedCarteIdsForPoint(db, commerce.id, pointVente.id);
  const { data: cartes } = scopedCarteIds.length
    ? await db
      .from('cartes')
      .select('id, push_icon_bg_color, updated_at')
      .in('id', scopedCarteIds)
      .eq('commerce_id', commerce.id)
      .order('updated_at', { ascending: false })
    : { data: [] as Array<{ id: string; push_icon_bg_color?: string | null; updated_at?: string | null }> };

  const carte = (cartes ?? [])[0] ?? null;

  return c.json({
    data: {
      has_active_card: Boolean(carte),
      cards_count: (cartes ?? []).length,
      scoped_cards_count: scopedCarteIds.length,
      point_vente_id: pointVente.id,
      push_icon_bg_color: (carte as { push_icon_bg_color?: string | null } | null)?.push_icon_bg_color ?? '#6366f1',
    },
  });
});

/** PATCH /api/notifications/push-icon-settings — Met à jour la couleur de fond du logo push */
notificationsRoutes.patch('/push-icon-settings', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    push_icon_bg_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  }).safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Couleur invalide.' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const carteIds = await resolveScopedCarteIdsForPoint(db, commerce.id, pointVente.id);
  if (!carteIds.length) return c.json({ error: 'Aucune carte active sur ce point de vente.' }, 404);

  const { error } = await db
    .from('cartes')
    .update({
      push_icon_bg_color: parsed.data.push_icon_bg_color,
      updated_at: new Date().toISOString(),
    })
    .in('id', carteIds)
    .eq('commerce_id', commerce.id);

  if (error) return c.json({ error: 'Impossible de mettre à jour la couleur.' }, 500);

  let appleRefreshSent = 0;

  const { data: appleClients, error: appleClientsError } = await db
    .from('clients')
    .select('id')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .not('apple_pass_serial', 'is', null);

  if (appleClientsError) {
    console.error('[push-icon-settings clients]', appleClientsError);
  } else if ((appleClients ?? []).length > 0) {
    const clientIds = (appleClients ?? []).map((client) => client.id).filter(Boolean);
    const { data: registrations, error: registrationsError } = await db
      .from('apple_pass_registrations')
      .select('client_id, push_token, pass_type_identifier')
      .in('client_id', clientIds);

    if (registrationsError) {
      console.error('[push-icon-settings registrations]', registrationsError);
    } else {
      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      const refreshResults = await Promise.allSettled(
        uniqueRegistrations.map((registration) => pushApplePassUpdate(
          registration.push_token,
          passTypeId || registration.pass_type_identifier,
        )),
      );
      appleRefreshSent = refreshResults.filter((result) => result.status === 'fulfilled').length;

      for (const result of refreshResults) {
        if (result.status === 'rejected') {
          console.error('[push-icon-settings apple refresh]', result.reason);
        }
      }
    }
  }

  return c.json({
    ok: true,
    data: {
      push_icon_bg_color: parsed.data.push_icon_bg_color,
      updated_cards_count: carteIds.length,
      point_vente_id: pointVente.id,
      apple_refresh_sent: appleRefreshSent,
    },
  });
});

/** GET /api/notifications/summary — Résumé des canaux réellement disponibles */
notificationsRoutes.get('/summary', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan, plan_override');

  if (!commerce || !pointVente) {
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
      .eq('point_vente_id', pointVente.id)
      .eq('push_enabled', true)
      .not('fcm_token', 'is', null),
    db
      .from('clients')
      .select('id, apple_pass_serial, google_pass_id')
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id),
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
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan, plan_override');

  if (!commerce || !pointVente) return c.json({ data: [] });

  const { data } = await db
    .from('notifications')
    .select('*')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  return c.json({ data: data ?? [] });
});

/** POST /api/notifications — Envoie une notification à tous les clients */
notificationsRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const requestedPointVenteId = readRequestedPointVenteId(c);

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
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan, plan_override');

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  // Récupère les clients joignables par web push ou Wallet
  const { data: clients } = await db
    .from('clients')
    .select('id, fcm_token, push_enabled, google_pass_id, apple_pass_serial')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
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
      point_vente_id: pointVente.id,
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
      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      const appleResults = await Promise.allSettled(
        uniqueRegistrations.map(async (registration) => {
          await pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier);
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

/** POST /api/notifications/review-campaign — Envoie le lien avis Google à chaque client (lien personnalisé) */
notificationsRoutes.post('/review-campaign', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override, nom',
  );
  const commerceError = null;

  console.log('[review-campaign] commerce:', commerce?.id, '| plan:', commerce?.plan, '| error:', commerceError?.message);

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);
  const flags = await loadCommerceFlags(db, commerce.id);

  // Vérification plan : avis Google réservé au plan Pro
  const effectivePlan = getEffectivePlanRaw(commerce);
  const planLimits = getPlanLimits(effectivePlan);
  console.log('[review-campaign] planLimits.avisGoogle:', planLimits.avisGoogle);
  if (!planLimits.avisGoogle) {
    return c.json({
      error: `La campagne avis Google est réservée au plan Pro. Plan actuel : ${effectivePlan}. Mettez à niveau votre abonnement.`,
      plan: effectivePlan,
    }, 403);
  }

  // Vérifie que la fonctionnalité est activée sur la carte
  const { data: carte, error: carteError } = await db
    .from('cartes')
    .select('id, nom, type, review_reward_enabled, review_reward_value, google_maps_url')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('actif', true)
    .single();

  console.log('[review-campaign] carte:', carte?.id, '| review_reward_enabled:', carte?.review_reward_enabled, '| error:', carteError?.message);

  if (!carte) return c.json({ error: 'Carte active introuvable' }, 404);
  if (!carte.review_reward_enabled) {
    return c.json({ error: "Activez d'abord la récompense avis Google dans l'éditeur de carte (étape Options)." }, 403);
  }

  // Récupère les clients qui n'ont pas encore réclamé
  const { data: alreadyClaimed } = await db
    .from('review_rewards')
    .select('client_id')
    .eq('carte_id', carte.id);

  const claimedIds = new Set((alreadyClaimed ?? []).map((r) => r.client_id));

  const { data: clients } = await db
    .from('clients')
    .select('id, nom, telephone, fcm_token, push_enabled, google_pass_id, apple_pass_serial')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id);

  const eligibles = (clients ?? []).filter((cl) => !claimedIds.has(cl.id));

  console.log('[review-campaign] total clients:', (clients ?? []).length, '| eligibles:', eligibles.length, '| already claimed:', claimedIds.size);

  if (eligibles.length === 0) {
    return c.json({ message: 'Tous vos clients ont déjà réclamé leur récompense.', nb_envoyes: 0, nb_eligibles: 0, nb_deja_reclame: claimedIds.size }, 200);
  }

  // Canaux disponibles
  const fcmEligibles = eligibles.filter((cl) => cl.push_enabled && cl.fcm_token);
  const googleEligibles = eligibles.filter((cl) => !!cl.google_pass_id);
  const appleEligibles = eligibles.filter((cl) => !!cl.apple_pass_serial);

  console.log('[review-campaign] canaux — FCM:', fcmEligibles.length, '| Google Wallet:', googleEligibles.length, '| Apple Wallet:', appleEligibles.length);

  if (fcmEligibles.length === 0 && googleEligibles.length === 0 && appleEligibles.length === 0) {
    return c.json({
      message: `${eligibles.length} client(s) éligible(s) mais aucun n'a de canal de notification actif (pas de token push, pas de Wallet).`,
      nb_envoyes: 0,
      nb_eligibles: eligibles.length,
      nb_deja_reclame: claimedIds.size,
    }, 200);
  }

  const unit = carte.type === 'tampons'
    ? (carte.review_reward_value ?? 1) === 1 ? '1 tampon offert' : `${carte.review_reward_value} tampons offerts`
    : (carte.review_reward_value ?? 1) === 1 ? '1 point offert' : `${carte.review_reward_value} points offerts`;

  const titre = `⭐ ${carte.nom} — ${unit}`;
  const message = `Laissez un avis Google sur ${carte.nom} et recevez votre récompense immédiatement.`;

  let nbEnvoyes = 0;

  // ── Étape clé pour Apple Wallet ─────────────────────────────────────
  // Apple Wallet fonctionne via un push SILENCIEUX (payload={}, apns-push-type:background).
  // Quand iOS reçoit ce push, il appelle GET /apple/v1/passes/:type/:serial pour
  // récupérer le pass mis à jour. Le pass injecte `latestNotification` (depuis la table
  // `notifications`) dans un backField "message_wallet" avec un `changeMessage`.
  // C'est ce changeMessage qui déclenche la bannière visible sur l'iPhone — PAS le payload APNs.
  //
  // Donc : on insère d'abord dans `notifications` pour que iOS récupère le bon message,
  // puis on envoie le push silencieux.
  await db.from('notifications').insert({
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
    titre,
    message,
    type: 'promo',
    nb_destinataires: eligibles.length,
    nb_delivrees: 0,
  });
  console.log('[review-campaign] notification insérée dans la table pour que Apple Wallet la détecte au fetch du pass');

  // 1. Web push (FCM) — lien personnalisé par client
  if (fcmEligibles.length > 0) {
    const fcmRecipients = fcmEligibles.map((cl) => ({
      token: cl.fcm_token as string,
      clickUrl: `${PUBLIC_SITE_URL}/review/${carte.id}?client_id=${cl.id}`,
    }));
    const sent = await sendPersonalizedPushNotifications(fcmRecipients, titre, message).catch((err) => {
      console.error('[review-campaign fcm]', err);
      return 0;
    });
    console.log('[review-campaign] FCM envoyés:', sent, '/', fcmEligibles.length);
    nbEnvoyes += sent;
  }

  // 2. Google Wallet — message avec lien cliquable
  for (const cl of googleEligibles) {
    const reviewUrl = `${PUBLIC_SITE_URL}/review/${carte.id}?client_id=${cl.id}`;
    await sendGoogleWalletMessage(
      cl.google_pass_id as string,
      titre,
      `${message}\n👉 ${reviewUrl}`,
    ).then(() => { nbEnvoyes++; }).catch((err) => console.error('[review-campaign google wallet]', err));
  }
  console.log('[review-campaign] Google Wallet traités:', googleEligibles.length);

  // 3. Apple Wallet — push SILENCIEUX (payload={}, apns-push-type:background, priority:5)
  //    iOS reçoit le push → appelle GET /apple/v1/passes/:type/:serial
  //    → le pass est régénéré avec latestNotification (inséré ci-dessus)
  //    → backField "message_wallet" change → iOS affiche le changeMessage en bannière visible
  if (appleEligibles.length > 0) {
    const appleIds = appleEligibles.map((cl) => cl.id);
    const { data: registrations } = await db
      .from('apple_pass_registrations')
      .select('client_id, push_token, pass_type_identifier')
      .in('client_id', appleIds);

    console.log('[review-campaign] Apple registrations trouvées:', (registrations ?? []).length, '/', appleEligibles.length);

    const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
    const uniqueRegistrations = Array.from(
      new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
    );
    await Promise.allSettled(
      uniqueRegistrations.map((r) => pushApplePassUpdate(
        r.push_token,
        passTypeId || r.pass_type_identifier,
      ).then(() => { nbEnvoyes++; })
        .catch((err) => console.error('[review-campaign apple wallet]', err))),
    );
  }

  console.log('[review-campaign] TOTAL envoyés:', nbEnvoyes, '/ eligibles:', eligibles.length);

  // 4. SMS (si toggle activé et crédits disponibles)
  let nbSmsEnvoyes = 0;
  if (Boolean(flags?.sms_review_enabled) && Number(flags?.sms_credits ?? 0) > 0) {
    const lienAvis = (carte as { google_maps_url?: string | null }).google_maps_url ?? '';
    const smsEligibles = eligibles.filter((cl) => !!(cl as { telephone?: string | null }).telephone);
    console.log('[review-campaign] SMS éligibles:', smsEligibles.length);

    for (const cl of smsEligibles) {
      const telephone = (cl as { telephone: string }).telephone;
      const msg = personnaliserMessage(
        'Bonjour {prenom} ! Laissez un avis Google sur {commerce} et recevez votre récompense : {lien_avis}',
        {
          prenom: (cl as { nom?: string | null }).nom ?? '',
          commerce: (commerce.nom as string | null) ?? '',
          lien_avis: lienAvis,
          lien_carte: `${PUBLIC_SITE_URL_NOTIF}/carte/${carte.id}`,
        },
      );
      const result = await sendSMS(telephone, msg, commerce.id, cl.id, 'review');
      if (result.success) nbSmsEnvoyes++;
    }
    console.log('[review-campaign] SMS envoyés:', nbSmsEnvoyes);
  }

  return c.json({
    nb_eligibles: eligibles.length,
    nb_envoyes: nbEnvoyes,
    nb_deja_reclame: claimedIds.size,
    nb_sms: nbSmsEnvoyes,
    detail: {
      fcm: fcmEligibles.length,
      google_wallet: googleEligibles.length,
      apple_wallet: appleEligibles.length,
      sms: nbSmsEnvoyes,
    },
  }, 201);
});
