import * as admin from 'firebase-admin';

let firebaseApp: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App {
  if (firebaseApp) return firebaseApp;

  if (!admin.apps.length) {
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
 * Retourne le nombre de notifications délivrées avec succès.
 */
export async function sendPushNotification(
  tokens: string[],
  title: string,
  body: string,
): Promise<number> {
  if (tokens.length === 0) return 0;

  const app = getFirebaseApp();
  const messaging = admin.messaging(app);

  // Envoie par lots de 500 (limite FCM)
  const BATCH_SIZE = 500;
  let successCount = 0;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        webpush: {
          notification: { title, body, icon: '/favicon.svg' },
        },
      });
      successCount += response.successCount;
    } catch (err) {
      console.error('[FCM] Erreur envoi batch:', err);
    }
  }

  return successCount;
}
