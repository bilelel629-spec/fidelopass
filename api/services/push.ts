import * as admin from 'firebase-admin';

let firebaseApp: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App {
  if (firebaseApp) return firebaseApp;

  if (!admin.apps.length) {
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Configuration Firebase Admin manquante');
    }
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
  } else {
    firebaseApp = admin.app();
  }

  return firebaseApp;
}

const INVALID_FCM_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export interface PushResult {
  successCount: number;
  successfulTokens: string[];
  invalidTokens: string[];
}

/**
 * Envoie une notification push à une liste de tokens FCM.
 * Retourne le nombre de succès, les tokens ayant réussi, et les tokens invalides à supprimer.
 */
export async function sendPushNotification(
  tokens: string[],
  title: string,
  body: string,
  clickUrl = '/',
  iconUrl?: string,
): Promise<PushResult> {
  if (tokens.length === 0) return { successCount: 0, successfulTokens: [], invalidTokens: [] };

  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  const icon = iconUrl || '/icons/icon-192.png';
  const BATCH_SIZE = 500;
  const successfulTokens: string[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        data: { title, body, url: clickUrl, icon },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: clickUrl },
        },
      });

      response.responses.forEach((res, idx) => {
        const token = batch[idx];
        if (res.success) {
          successfulTokens.push(token);
        } else if (res.error && INVALID_FCM_ERRORS.has(res.error.code)) {
          invalidTokens.push(token);
        }
      });
    } catch (err) {
      console.error('[FCM] Erreur envoi batch (tokens', i, '-', i + batch.length - 1, '):', err);
    }
  }

  return { successCount: successfulTokens.length, successfulTokens, invalidTokens };
}

/**
 * Envoie une notification personnalisée à chaque token avec son propre URL.
 * Utilisé pour les campagnes où chaque client a un lien unique.
 */
export async function sendPersonalizedPushNotifications(
  recipients: Array<{ token: string; clickUrl: string }>,
  title: string,
  body: string,
  iconUrl?: string,
): Promise<PushResult> {
  if (recipients.length === 0) return { successCount: 0, successfulTokens: [], invalidTokens: [] };

  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  const icon = iconUrl || '/icons/icon-192.png';
  const BATCH_SIZE = 500;
  const successfulTokens: string[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    try {
      const messages = batch.map((r) => ({
        token: r.token,
        data: { title, body, url: r.clickUrl, icon },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: r.clickUrl },
        },
      }));
      const response = await messaging.sendEach(messages);

      response.responses.forEach((res, idx) => {
        const token = batch[idx].token;
        if (res.success) {
          successfulTokens.push(token);
        } else if (res.error && INVALID_FCM_ERRORS.has(res.error.code)) {
          invalidTokens.push(token);
        }
      });
    } catch (err) {
      console.error('[FCM] Erreur envoi personnalisé batch (tokens', i, '-', i + batch.length - 1, '):', err);
    }
  }

  return { successCount: successfulTokens.length, successfulTokens, invalidTokens };
}
