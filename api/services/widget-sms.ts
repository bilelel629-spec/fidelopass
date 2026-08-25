import { normalizePhoneE164 } from '../utils/phone';

export type WidgetSmsResult = { ok: true; messageId?: string } | { ok: false; error: string };

/** SMS transactionnel OTP: aucun credit campagne debite et aucun code journalise. */
export async function sendWidgetOtpSms(phone: string, otp: string): Promise<WidgetSmsResult> {
  const apiKey = (process.env.BREVO_API_KEY ?? '').trim();
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY manquant' };

  const recipient = normalizePhoneE164(phone);
  if (!recipient) return { ok: false, error: 'Numero mobile invalide' };

  const sender = (process.env.WIDGET_SMS_SENDER ?? 'FideloPass').trim().slice(0, 11) || 'FideloPass';
  const response = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender,
      recipient,
      content: `Fidelopass : votre code de connexion est ${otp}. Ne le partagez pas.`,
      type: 'transactional',
    }),
  });

  const payload = await response.json().catch(() => ({})) as { messageId?: string; message?: string };
  if (!response.ok) {
    console.error('[widget-sms] envoi refuse', { status: response.status, providerMessage: payload.message ?? null });
    return { ok: false, error: `Brevo HTTP ${response.status}` };
  }

  return { ok: true, messageId: payload.messageId };
}
