import { createServiceClient } from './supabase';

/** Normalise un numéro FR vers le format E.164 (+33XXXXXXXXX) */
export function normalizePhoneFR(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  // Déjà E.164
  if (digits.startsWith('+')) return digits;
  // 06XXXXXXXX ou 07XXXXXXXX → +336XXXXXXXX / +337XXXXXXXX
  if (/^0[67]/.test(digits)) return '+33' + digits.slice(1);
  // 33XXXXXXXXX → +33XXXXXXXXX
  if (digits.startsWith('33') && digits.length === 11) return '+' + digits;
  // Fallback : retourne tel quel
  return digits;
}

/** Remplace les variables de personnalisation dans un message */
export function personnaliserMessage(
  message: string,
  vars: { prenom?: string; commerce?: string; lien_avis?: string; lien_carte?: string },
): string {
  return message
    .replace(/\{prenom\}/gi, vars.prenom ?? '')
    .replace(/\{commerce\}/gi, vars.commerce ?? '')
    .replace(/\{lien_avis\}/gi, vars.lien_avis ?? '')
    .replace(/\{lien_carte\}/gi, vars.lien_carte ?? '');
}

export interface SendSMSResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

/**
 * Envoie un SMS via Brevo, décrémente les crédits et insère un log.
 */
export async function sendSMS(
  telephone: string,
  message: string,
  commerceId: string,
  clientId: string | null,
  type: string,
): Promise<SendSMSResult> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'BREVO_API_KEY manquant' };
  }

  const db = createServiceClient();

  // Vérification des crédits
  const { data: commerce, error: commerceErr } = await db
    .from('commerces')
    .select('sms_credits')
    .eq('id', commerceId)
    .single();

  if (commerceErr || !commerce) {
    return { success: false, error: 'Commerce introuvable' };
  }

  if ((commerce.sms_credits ?? 0) < 1) {
    return { success: false, error: "Crédits SMS insuffisants. Les campagnes SMS sont temporairement en pause." };
  }

  const recipient = normalizePhoneFR(telephone);

  // Appel API Brevo
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: 'FideloPass',
      recipient,
      content: message,
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMsg = (body as { message?: string }).message ?? `HTTP ${res.status}`;
    console.error('[brevo-sms] Erreur:', errMsg);
    // Log de l'échec
    await db.from('sms_logs').insert({
      commerce_id: commerceId,
      client_id: clientId,
      type,
      telephone: recipient,
      message,
      statut: 'echec',
      credits_debites: 0,
    });
    return { success: false, error: errMsg };
  }

  // Décrémenter les crédits
  await db
    .from('commerces')
    .update({ sms_credits: Math.max(0, (commerce.sms_credits ?? 0) - 1) })
    .eq('id', commerceId);

  // Insérer le log
  await db.from('sms_logs').insert({
    commerce_id: commerceId,
    client_id: clientId,
    type,
    telephone: recipient,
    message,
    statut: 'envoye',
    credits_debites: 1,
  });

  return {
    success: true,
    messageId: (body as { messageId?: string }).messageId,
  };
}

/**
 * Planifie un SMS différé (inséré dans sms_scheduled).
 */
export async function scheduleSMS(
  telephone: string,
  message: string,
  commerceId: string,
  clientId: string | null,
  type: string,
  delayMinutes: number,
): Promise<void> {
  const db = createServiceClient();
  const sendAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  await db.from('sms_scheduled').insert({
    commerce_id: commerceId,
    client_id: clientId,
    telephone,
    message,
    type,
    send_at: sendAt,
    sent: false,
  });
}
