import * as admin from 'firebase-admin';

let firebaseApp: admin.app.App | null = null;

export type PushDeliveryResult = {
  successCount: number;
  failedCount: number;
  successTokens: string[];
  failedTokens: string[];
};

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

/**
 * Envoie une notification push à une liste de tokens FCM.
 * Retourne le détail des notifications délivrées avec succès/échec.
 */
export async function sendPushNotificationDetailed(
  tokens: string[],
  title: string,
  body: string,
  clickUrl = '/',
): Promise<PushDeliveryResult> {
  if (tokens.length === 0) {
    return { successCount: 0, failedCount: 0, successTokens: [], failedTokens: [] };
  }

  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  const BATCH_SIZE = 500;
  const successTokens: string[] = [];
  const failedTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: { title, body, url: clickUrl, icon: '/icons/icon-192.png' },
        webpush: {
          notification: { title, body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' },
          fcmOptions: { link: clickUrl },
        },
      });
      response.responses.forEach((item, index) => {
        const token = batch[index];
        if (!token) return;
        if (item.success) successTokens.push(token);
        else failedTokens.push(token);
      });
    } catch (err) {
      console.error('[FCM] Erreur envoi batch:', err);
      failedTokens.push(...batch);
    }
  }

  return {
    successCount: successTokens.length,
    failedCount: failedTokens.length,
    successTokens,
    failedTokens,
  };
}

/**
 * Envoie une notification push à une liste de tokens FCM.
 * Retourne le nombre de notifications délivrées avec succès.
 */
export async function sendPushNotification(
  tokens: string[],
  title: string,
  body: string,
  clickUrl = '/',
): Promise<number> {
  const result = await sendPushNotificationDetailed(tokens, title, body, clickUrl);
  return result.successCount;
}

/**
 * Envoie une notification personnalisée à chaque token avec son propre URL.
 * Utilisé pour les campagnes où chaque client a un lien unique.
 */
export async function sendPersonalizedPushNotifications(
  recipients: Array<{ token: string; clickUrl: string }>,
  title: string,
  body: string,
): Promise<number> {
  if (recipients.length === 0) return 0;

  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  const BATCH_SIZE = 500;
  let successCount = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    try {
      const messages = batch.map((r) => ({
        token: r.token,
        notification: { title, body },
        data: { title, body, url: r.clickUrl, icon: '/icons/icon-192.png' },
        webpush: {
          notification: { title, body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' },
          fcmOptions: { link: r.clickUrl },
        },
      }));
      const response = await messaging.sendEach(messages);
      successCount += response.successCount;
    } catch (err) {
      console.error('[FCM] Erreur envoi personnalisé batch:', err);
    }
  }

  return successCount;
}
