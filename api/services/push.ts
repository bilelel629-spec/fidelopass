import webpush from 'web-push';

let webPushConfigured = false;

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PersonalizedWebPushTarget extends WebPushTarget {
  clickUrl: string;
}

export interface PushResult {
  successCount: number;
  successfulTokens: string[];
  invalidTokens: string[];
}

function getVapidConfig() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    ?? process.env.PUBLIC_WEB_PUSH_VAPID_KEY
    ?? '';
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '';
  let subject = process.env.WEB_PUSH_SUBJECT ?? '';
  if (!subject && process.env.PUBLIC_SITE_URL) {
    subject = `mailto:contact@${new URL(process.env.PUBLIC_SITE_URL).hostname}`;
  }
  if (!subject) {
    subject = 'mailto:contact@duo-agency.com';
  }

  return { publicKey, privateKey, subject };
}

function ensureWebPushConfigured() {
  if (webPushConfigured) return true;

  const { publicKey, privateKey, subject } = getVapidConfig();
  if (!publicKey || !privateKey) {
    console.warn('[web-push] VAPID keys missing');
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  webPushConfigured = true;
  return true;
}

function toSubscription(target: WebPushTarget): webpush.PushSubscription {
  return {
    endpoint: target.endpoint,
    keys: {
      p256dh: target.p256dh,
      auth: target.auth,
    },
  };
}

function isInvalidSubscriptionError(error: unknown) {
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  return statusCode === 400 || statusCode === 404 || statusCode === 410;
}

async function sendOne(target: WebPushTarget, title: string, body: string, clickUrl: string, iconUrl?: string) {
  const payload = JSON.stringify({
    title,
    body,
    icon: iconUrl || '/favicon.png',
    url: clickUrl || '/',
  });

  await webpush.sendNotification(toSubscription(target), payload, {
    TTL: 60 * 60,
    urgency: 'high',
  });
}

/**
 * Envoie une notification web push native.
 * Les "tokens" retournés restent les endpoints pour garder les routes simples.
 */
export async function sendPushNotification(
  targets: WebPushTarget[],
  title: string,
  body: string,
  clickUrl = '/',
  iconUrl?: string,
): Promise<PushResult> {
  if (targets.length === 0) return { successCount: 0, successfulTokens: [], invalidTokens: [] };
  if (!ensureWebPushConfigured()) return { successCount: 0, successfulTokens: [], invalidTokens: [] };

  const successfulTokens: string[] = [];
  const invalidTokens: string[] = [];

  await Promise.allSettled(
    targets.map(async (target) => {
      try {
        await sendOne(target, title, body, clickUrl, iconUrl);
        successfulTokens.push(target.endpoint);
      } catch (error) {
        if (isInvalidSubscriptionError(error)) {
          invalidTokens.push(target.endpoint);
          return;
        }
        console.error('[web-push] Erreur envoi:', error);
      }
    }),
  );

  return { successCount: successfulTokens.length, successfulTokens, invalidTokens };
}

/**
 * Envoie une notification personnalisée à chaque abonnement avec son propre URL.
 */
export async function sendPersonalizedPushNotifications(
  recipients: PersonalizedWebPushTarget[],
  title: string,
  body: string,
  iconUrl?: string,
): Promise<PushResult> {
  if (recipients.length === 0) return { successCount: 0, successfulTokens: [], invalidTokens: [] };
  if (!ensureWebPushConfigured()) return { successCount: 0, successfulTokens: [], invalidTokens: [] };

  const successfulTokens: string[] = [];
  const invalidTokens: string[] = [];

  await Promise.allSettled(
    recipients.map(async (recipient) => {
      try {
        await sendOne(recipient, title, body, recipient.clickUrl, iconUrl);
        successfulTokens.push(recipient.endpoint);
      } catch (error) {
        if (isInvalidSubscriptionError(error)) {
          invalidTokens.push(recipient.endpoint);
          return;
        }
        console.error('[web-push] Erreur envoi personnalisé:', error);
      }
    }),
  );

  return { successCount: successfulTokens.length, successfulTokens, invalidTokens };
}
