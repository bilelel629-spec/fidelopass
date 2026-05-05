import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { sendSMS } from '../../src/lib/brevo-sms';
import { sendPersonalizedPushNotifications } from '../services/push';
import { sendGoogleWalletMessage, updateGooglePassObject } from '../services/google-wallet';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { getPlanLimits } from './commerces';
import { getEffectivePlanRaw } from '../utils/effective-plan';
import { getPublicSiteUrl } from '../utils/public-site-url';

export const cronRoutes = new Hono();
const PUBLIC_SITE_URL = getPublicSiteUrl();
const BIRTHDAY_TIMEZONE = 'Europe/Paris';
const BIRTHDAY_SEND_HOUR = 10;
const BIRTHDAY_WINDOW_MAX_MINUTE = 5;
const DEFAULT_BIRTHDAY_PUSH_TITLE = 'Joyeux anniversaire 🎉';
const DEFAULT_BIRTHDAY_PUSH_MESSAGE = 'Votre bonus anniversaire est disponible sur votre carte Fidelopass.';
const SMS_FEATURE_ENABLED = process.env.SMS_FEATURE_ENABLED === 'true';

type CronCarteRow = {
  id: string;
  nom: string;
  type: 'points' | 'tampons';
  tampons_total: number;
  points_recompense: number;
  recompense_description: string | null;
  couleur_fond: string;
  logo_url: string | null;
  strip_url: string | null;
  barcode_type: string | null;
  label_client: string | null;
  rewards_config: Array<{ seuil: number; recompense: string }> | null;
  vip_tiers: Array<{ nom: string; seuil: number; avantage?: string }> | null;
  branding_powered_by_enabled: boolean | null;
  birthday_reward_value: number | null;
  birthday_push_title: string | null;
  birthday_push_message: string | null;
  point_vente_id: string;
  commerces: {
    nom: string;
    logo_url: string | null;
    plan: string | null;
  } | null;
  points_vente: {
    nom?: string | null;
    latitude: number | null;
    longitude: number | null;
    rayon_geo: number | null;
  } | null;
};

type CronClientRow = {
  id: string;
  nom: string | null;
  date_naissance: string | null;
  fcm_token: string | null;
  push_enabled: boolean;
  google_pass_id: string | null;
  apple_pass_serial: string | null;
  points_actuels: number;
  tampons_actuels: number;
  recompenses_obtenues: number;
};

function getParisDateParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number; monthDay: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: BIRTHDAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (key: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === key)?.value ?? '0');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  return {
    year,
    month,
    day,
    hour,
    minute,
    monthDay: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function isBirthdayWindowOpen(now: Date): boolean {
  const { hour, minute } = getParisDateParts(now);
  return hour === BIRTHDAY_SEND_HOUR && minute >= 0 && minute <= BIRTHDAY_WINDOW_MAX_MINUTE;
}

function monthDayFromBirthDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

function computeBirthdayReward(
  carte: Pick<CronCarteRow, 'type' | 'tampons_total' | 'points_recompense'>,
  client: Pick<CronClientRow, 'points_actuels' | 'tampons_actuels' | 'recompenses_obtenues'>,
  rewardValue: number,
) {
  let newPoints = client.points_actuels;
  let newTampons = client.tampons_actuels;
  let recompensesObtenues = client.recompenses_obtenues;

  if (carte.type === 'tampons') {
    newTampons += rewardValue;
    if (newTampons >= carte.tampons_total) {
      recompensesObtenues += Math.floor(newTampons / carte.tampons_total);
      newTampons = carte.tampons_total;
    }
  } else {
    newPoints += rewardValue;
    if (newPoints >= carte.points_recompense) {
      recompensesObtenues += Math.floor(newPoints / carte.points_recompense);
      newPoints = carte.points_recompense;
    }
  }

  return { newPoints, newTampons, recompensesObtenues };
}

async function sendScheduledReviewPushes(db: ReturnType<typeof createServiceClient>) {
  const now = Date.now();
  const windowStart = new Date(now - 65 * 60 * 1000).toISOString();
  const windowEnd = new Date(now - 60 * 60 * 1000).toISOString();
  const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';

  let commercesProcessed = 0;
  let pushesSent = 0;
  let eligibleClients = 0;

  const { data: commerces, error: commercesError } = await db
    .from('commerces')
    .select('*')
    .eq('actif', true);

  if (commercesError) {
    console.error('[cron] Erreur lecture commerces pour push avis auto:', commercesError.message);
    return { commerces_processed: 0, eligible_clients: 0, pushes_sent: 0 };
  }

  for (const commerce of commerces ?? []) {
    if (!getPlanLimits(getEffectivePlanRaw(commerce)).avisGoogle) continue;
    const reviewAutoEnabled = Boolean(
      (commerce as { review_auto_enabled?: boolean | null }).review_auto_enabled
      ?? (commerce as { sms_review_enabled?: boolean | null }).sms_review_enabled,
    );
    if (!reviewAutoEnabled) continue;
    commercesProcessed++;

    const { data: cartes } = await db
      .from('cartes')
      .select('id, nom, google_maps_url, point_vente_id')
      .eq('commerce_id', commerce.id)
      .eq('actif', true)
      .order('created_at', { ascending: true });

    for (const carte of cartes ?? []) {
      const { data: clients } = await db
        .from('clients')
        .select('id, nom, fcm_token, push_enabled, google_pass_id, apple_pass_serial, created_at')
        .eq('commerce_id', commerce.id)
        .eq('carte_id', carte.id)
        .gt('created_at', windowStart)
        .lte('created_at', windowEnd);

      if (!clients?.length) continue;

      const reviewUrl = carte.google_maps_url?.trim()
        ? carte.google_maps_url.trim()
        : `${PUBLIC_SITE_URL}/carte/${carte.id}`;

      const messageTitle = `Votre avis compte pour ${carte.nom}`;
      const messageBody = `Merci d'avoir ajouté votre carte ${carte.nom}. Donnez-nous votre avis Google en 30 secondes.`;

      const webPushClients = clients.filter((client) => client.push_enabled && client.fcm_token);
      const googleWalletClients = clients.filter((client) => Boolean(client.google_pass_id));
      const appleWalletClients = clients.filter((client) => Boolean(client.apple_pass_serial));

      const targetClientIds = new Set<string>([
        ...webPushClients.map((c) => c.id),
        ...googleWalletClients.map((c) => c.id),
        ...appleWalletClients.map((c) => c.id),
      ]);

      if (targetClientIds.size === 0) continue;
      eligibleClients += targetClientIds.size;

      const { data: insertedNotif } = await db
        .from('notifications')
        .insert({
          commerce_id: commerce.id,
          point_vente_id: carte.point_vente_id,
          titre: messageTitle,
          message: messageBody,
          type: 'review_auto',
          nb_destinataires: targetClientIds.size,
          nb_delivrees: 0,
        })
        .select('id')
        .single();

      const deliveredClientIds = new Set<string>();

      if (webPushClients.length > 0) {
        const webRecipients = webPushClients.map((client) => ({
          token: client.fcm_token as string,
          clickUrl: reviewUrl,
        }));

        const webSent = await sendPersonalizedPushNotifications(webRecipients, messageTitle, messageBody)
          .catch((err) => {
            console.error('[cron review-auto webpush]', err);
            return 0;
          });

        pushesSent += webSent;
        webPushClients.slice(0, webSent).forEach((client) => deliveredClientIds.add(client.id));
      }

      for (const client of googleWalletClients) {
        await sendGoogleWalletMessage(
          client.google_pass_id as string,
          messageTitle,
          `${messageBody}\n${reviewUrl}`,
          insertedNotif?.id,
        )
          .then(() => {
            pushesSent++;
            deliveredClientIds.add(client.id);
          })
          .catch((err) => console.error('[cron review-auto google-wallet]', err));
      }

      if (appleWalletClients.length > 0) {
        const { data: registrations } = await db
          .from('apple_pass_registrations')
          .select('client_id, push_token, pass_type_identifier')
          .in('client_id', appleWalletClients.map((client) => client.id));

        const uniqueRegistrations = Array.from(
          new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
        );

        await Promise.allSettled(
          uniqueRegistrations.map((registration) => pushApplePassUpdate(
            registration.push_token,
            passTypeId || registration.pass_type_identifier,
          )
            .then(() => {
              pushesSent++;
              deliveredClientIds.add(registration.client_id);
            })
            .catch((err) => console.error('[cron review-auto apple-wallet]', err))),
        );
      }

      if (insertedNotif?.id) {
        await db
          .from('notifications')
          .update({ nb_delivrees: deliveredClientIds.size })
          .eq('id', insertedNotif.id);
      }
    }
  }

  return {
    commerces_processed: commercesProcessed,
    eligible_clients: eligibleClients,
    pushes_sent: pushesSent,
  };
}

async function sendScheduledBirthdayPushes(db: ReturnType<typeof createServiceClient>) {
  const now = new Date();
  const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';

  if (!isBirthdayWindowOpen(now)) {
    return {
      commerces_processed: 0,
      eligible_clients: 0,
      rewarded: 0,
      pushes_sent: 0,
      skipped_already_sent: 0,
      skipped_window: true,
    };
  }

  const parisDate = getParisDateParts(now);

  let commercesProcessed = 0;
  let eligibleClients = 0;
  let rewarded = 0;
  let pushesSent = 0;
  let skippedAlreadySent = 0;

  try {
    const { data: commerces, error: commercesError } = await db
      .from('commerces')
      .select('*')
      .eq('actif', true);

    if (commercesError) {
      console.error('[cron birthday] Erreur lecture commerces:', commercesError.message);
      return {
        commerces_processed: 0,
        eligible_clients: 0,
        rewarded: 0,
        pushes_sent: 0,
        skipped_already_sent: 0,
      };
    }

    for (const commerce of commerces ?? []) {
      if (!getPlanLimits(getEffectivePlanRaw(commerce)).anniversaire) continue;
      commercesProcessed++;

      const { data: cartes, error: cartesError } = await db
        .from('cartes')
        .select(`
          id, nom, type, tampons_total, points_recompense, recompense_description,
          couleur_fond, logo_url, strip_url, barcode_type, label_client,
          rewards_config, vip_tiers, branding_powered_by_enabled,
          birthday_reward_value, birthday_push_title, birthday_push_message, point_vente_id,
          commerces(nom, logo_url, plan),
          points_vente(nom, latitude, longitude, rayon_geo)
        `)
        .eq('commerce_id', commerce.id)
        .eq('actif', true)
        .eq('birthday_auto_enabled', true);

      if (cartesError) {
        console.error('[cron birthday] Erreur lecture cartes:', cartesError.message);
        continue;
      }

      for (const carteRaw of (cartes ?? [])) {
        const carte = carteRaw as unknown as CronCarteRow;
        const rewardValue = Math.max(1, Math.min(50, Number(carte.birthday_reward_value ?? 1)));
        const messageTitle = (carte.birthday_push_title ?? '').trim() || DEFAULT_BIRTHDAY_PUSH_TITLE;
        const messageBody = (carte.birthday_push_message ?? '').trim() || DEFAULT_BIRTHDAY_PUSH_MESSAGE;

        const { data: clients, error: clientsError } = await db
          .from('clients')
          .select('id, nom, date_naissance, fcm_token, push_enabled, google_pass_id, apple_pass_serial, points_actuels, tampons_actuels, recompenses_obtenues')
          .eq('commerce_id', commerce.id)
          .eq('point_vente_id', carte.point_vente_id)
          .eq('carte_id', carte.id)
          .not('date_naissance', 'is', null);

        if (clientsError) {
          console.error('[cron birthday] Erreur lecture clients:', clientsError.message);
          continue;
        }

        const eligibleToday = (clients ?? [])
          .map((client) => client as unknown as CronClientRow)
          .filter((client) => monthDayFromBirthDate(client.date_naissance) === parisDate.monthDay);

        if (eligibleToday.length === 0) continue;
        eligibleClients += eligibleToday.length;

        const { data: alreadyRewardedRows, error: alreadyRewardedError } = await db
          .from('birthday_rewards')
          .select('client_id')
          .eq('carte_id', carte.id)
          .eq('birth_year', parisDate.year)
          .in('client_id', eligibleToday.map((client) => client.id));

        if (alreadyRewardedError) {
          console.error('[cron birthday] Erreur lecture birthday_rewards:', alreadyRewardedError.message);
          continue;
        }

        const alreadySentIds = new Set((alreadyRewardedRows ?? []).map((row) => row.client_id));
        const rewardedClients: Array<CronClientRow & { points_actuels: number; tampons_actuels: number; recompenses_obtenues: number }> = [];

        for (const client of eligibleToday) {
          if (alreadySentIds.has(client.id)) {
            skippedAlreadySent++;
            continue;
          }

          const insertReward = await db
            .from('birthday_rewards')
            .insert({
              client_id: client.id,
              carte_id: carte.id,
              birth_year: parisDate.year,
              reward_value: rewardValue,
            });

          if (insertReward.error) {
            const message = insertReward.error.message ?? '';
            if (/duplicate key|unique|already exists/i.test(message)) {
              skippedAlreadySent++;
              continue;
            }
            console.error('[cron birthday] Erreur insertion birthday_rewards:', message);
            continue;
          }

          const beforeScore = carte.type === 'tampons' ? client.tampons_actuels : client.points_actuels;
          const next = computeBirthdayReward(carte, client, rewardValue);
          const afterScore = carte.type === 'tampons' ? next.newTampons : next.newPoints;

          const [{ error: clientUpdateError }, { error: txError }] = await Promise.all([
            db
              .from('clients')
              .update({
                points_actuels: next.newPoints,
                tampons_actuels: next.newTampons,
                recompenses_obtenues: next.recompensesObtenues,
                updated_at: now.toISOString(),
              })
              .eq('id', client.id),
            db
              .from('transactions')
              .insert({
                client_id: client.id,
                commerce_id: commerce.id,
                point_vente_id: carte.point_vente_id,
                type: carte.type === 'tampons' ? 'ajout_tampon' : 'ajout_points',
                valeur: rewardValue,
                points_avant: beforeScore,
                points_apres: afterScore,
                note: 'Bonus anniversaire automatique',
              }),
          ]);

          if (clientUpdateError || txError) {
            console.error('[cron birthday] Erreur update client/transaction:', clientUpdateError?.message ?? txError?.message);
            continue;
          }

          rewarded++;
          rewardedClients.push({
            ...client,
            points_actuels: next.newPoints,
            tampons_actuels: next.newTampons,
            recompenses_obtenues: next.recompensesObtenues,
          });
        }

        if (rewardedClients.length === 0) continue;

        const { data: insertedNotif, error: notifError } = await db
          .from('notifications')
          .insert({
            commerce_id: commerce.id,
            point_vente_id: carte.point_vente_id,
            titre: messageTitle,
            message: messageBody,
            type: 'birthday_auto',
            nb_destinataires: rewardedClients.length,
            nb_delivrees: 0,
          })
          .select('id')
          .single();

        if (notifError) {
          console.error('[cron birthday] Erreur insertion notification:', notifError.message);
          continue;
        }

        const deliveredClientIds = new Set<string>();
        const clickUrl = `${PUBLIC_SITE_URL}/carte/${carte.id}`;
        const commerceRef = Array.isArray(carte.commerces) ? carte.commerces[0] : carte.commerces;
        const pointVenteRef = Array.isArray(carte.points_vente) ? carte.points_vente[0] : carte.points_vente;
        const carteForWallet = {
          ...carte,
          commerces: {
            nom: pointVenteRef?.nom ?? commerceRef?.nom ?? commerce.nom ?? '',
            logo_url: commerceRef?.logo_url ?? null,
            latitude: pointVenteRef?.latitude ?? null,
            longitude: pointVenteRef?.longitude ?? null,
            rayon_geo: pointVenteRef?.rayon_geo ?? null,
            plan: getEffectivePlanRaw(commerce),
          },
        } as Parameters<typeof updateGooglePassObject>[1];

        const webPushClients = rewardedClients.filter((client) => client.push_enabled && client.fcm_token);
        if (webPushClients.length > 0) {
          const recipients = webPushClients.map((client) => ({
            token: client.fcm_token as string,
            clickUrl,
          }));
          const sent = await sendPersonalizedPushNotifications(recipients, messageTitle, messageBody).catch((err: unknown) => {
            console.error('[cron birthday webpush]', err);
            return 0;
          });
          pushesSent += sent;
          webPushClients.slice(0, sent).forEach((client) => deliveredClientIds.add(client.id));
        }

        const googleWalletClients = rewardedClients.filter((client) => Boolean(client.google_pass_id));
        for (const client of googleWalletClients) {
          await updateGooglePassObject(
            client.google_pass_id as string,
            carteForWallet,
            {
              id: client.id,
              nom: client.nom,
              points_actuels: client.points_actuels,
              tampons_actuels: client.tampons_actuels,
              recompenses_obtenues: client.recompenses_obtenues,
            },
          )
            .then(async () => {
              await sendGoogleWalletMessage(
                client.google_pass_id as string,
                messageTitle,
                `${messageBody}\n${clickUrl}`,
                insertedNotif?.id,
              );
              pushesSent++;
              deliveredClientIds.add(client.id);
            })
            .catch((err: unknown) => console.error('[cron birthday google-wallet]', err));
        }

        const appleWalletClients = rewardedClients.filter((client) => Boolean(client.apple_pass_serial));
        if (appleWalletClients.length > 0) {
          const { data: registrations, error: registrationsError } = await db
            .from('apple_pass_registrations')
            .select('client_id, push_token, pass_type_identifier')
            .in('client_id', appleWalletClients.map((client) => client.id));

          if (registrationsError) {
            console.error('[cron birthday apple registrations]', registrationsError.message);
          } else {
            const uniqueRegistrations = Array.from(
              new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
            );
            await Promise.allSettled(
              uniqueRegistrations.map((registration) =>
                pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier)
                  .then(() => {
                    pushesSent++;
                    deliveredClientIds.add(registration.client_id);
                  })
                  .catch((err) => console.error('[cron birthday apple-wallet]', err)),
              ),
            );
          }
        }

        await db
          .from('notifications')
          .update({ nb_delivrees: deliveredClientIds.size })
          .eq('id', insertedNotif.id);
      }
    }
  } catch (error) {
    console.error('[cron birthday] Erreur globale:', error);
  }

  return {
    commerces_processed: commercesProcessed,
    eligible_clients: eligibleClients,
    rewarded,
    pushes_sent: pushesSent,
    skipped_already_sent: skippedAlreadySent,
    skipped_window: false,
  };
}

/** GET /api/cron/send-scheduled-sms
 * Déclenché toutes les 5 minutes par Railway cron.
 * Header requis : Authorization: Bearer CRON_SECRET
 */
cronRoutes.get('/send-scheduled-sms', async (c) => {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '').trim();

  if (!expectedSecret || token !== expectedSecret) {
    return c.json({ error: 'Non autorisé' }, 401);
  }

  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data: pending, error } = await db
    .from('sms_scheduled')
    .select('*')
    .eq('sent', false)
    .lte('send_at', now)
    .limit(50); // Sécurité : max 50 par run

  if (error) {
    console.error('[cron] Erreur lecture sms_scheduled:', error.message);
    return c.json({ error: 'Erreur base de données' }, 500);
  }

  let sent = 0;
  let failed = 0;

  if (SMS_FEATURE_ENABLED && pending?.length) {
    for (const sms of pending) {
      const result = await sendSMS(
        sms.telephone,
        sms.message,
        sms.commerce_id,
        sms.client_id,
        sms.type,
      );

      // Marquer comme traité même si échec (évite les boucles infinies)
      await db.from('sms_scheduled').update({ sent: true }).eq('id', sms.id);

      if (result.success) {
        sent++;
      } else {
        failed++;
        console.error(`[cron] SMS ${sms.id} échoué:`, result.error);
      }
    }
  }

  const reviewAuto = await sendScheduledReviewPushes(db);
  const birthdayAuto = await sendScheduledBirthdayPushes(db);
  console.log(`[cron] send-scheduled-sms: ${sent} envoyés, ${failed} échecs`);
  console.log(
    `[cron] review-auto-push: commerces=${reviewAuto.commerces_processed}, éligibles=${reviewAuto.eligible_clients}, envoyés=${reviewAuto.pushes_sent}`,
  );
  console.log(
    `[cron] birthday-auto: commerces=${birthdayAuto.commerces_processed}, éligibles=${birthdayAuto.eligible_clients}, récompensés=${birthdayAuto.rewarded}, envoyés=${birthdayAuto.pushes_sent}, skip_doublons=${birthdayAuto.skipped_already_sent}, window=${birthdayAuto.skipped_window ? 'closed' : 'open'}`,
  );

  return c.json({
    sms: { sent, failed, total: pending?.length ?? 0 },
    review_auto_push: reviewAuto,
    birthday_auto_push: birthdayAuto,
  });
});
