import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { sendSMS } from '../../src/lib/brevo-sms';
import { sendPersonalizedPushNotifications } from '../services/push';
import { sendGoogleWalletMessage } from '../services/google-wallet';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { getPlanLimits, normalizePlan } from './commerces';

export const cronRoutes = new Hono();
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

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
    .select('id, nom, plan, sms_review_enabled')
    .eq('sms_review_enabled', true);

  if (commercesError) {
    console.error('[cron] Erreur lecture commerces pour push avis auto:', commercesError.message);
    return { commerces_processed: 0, eligible_clients: 0, pushes_sent: 0 };
  }

  for (const commerce of commerces ?? []) {
    if (!getPlanLimits(normalizePlan(commerce.plan)).avisGoogle) continue;
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

      const messageTitle = `Votre avis compte pour ${commerce.nom}`;
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

  if (pending?.length) {
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
  console.log(`[cron] send-scheduled-sms: ${sent} envoyés, ${failed} échecs`);
  console.log(
    `[cron] review-auto-push: commerces=${reviewAuto.commerces_processed}, éligibles=${reviewAuto.eligible_clients}, envoyés=${reviewAuto.pushes_sent}`,
  );

  return c.json({
    sms: { sent, failed, total: pending?.length ?? 0 },
    review_auto_push: reviewAuto,
  });
});
