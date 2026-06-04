import { getPublicSiteUrl } from '../utils/public-site-url';

type CardCreatedEmailInput = {
  toEmail: string;
  commerceName: string;
  cardName: string;
};

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_CONTACT_EMAIL = 'contact@duo-agency.com';

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildHtml(input: CardCreatedEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const safeCommerce = htmlEscape(input.commerceName || 'votre commerce');
  const safeCard = htmlEscape(input.cardName || 'votre carte');

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 18px 40px;">
      <div style="background:#ffffff;border:1px solid #dbeafe;border-radius:24px;overflow:hidden;box-shadow:0 24px 48px -26px rgba(15,23,42,.22);">
        <div style="padding:28px;background:linear-gradient(135deg,#0f172a 0%,#2563eb 62%,#38bdf8 100%);">
          <p style="margin:0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#bfdbfe;font-weight:700;">Carte créée</p>
          <h1 style="margin:12px 0 0;color:#fff;font-size:30px;line-height:1.12;font-weight:800;">
            Votre carte Fidelopass est prête.
          </h1>
        </div>
        <div style="padding:28px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Bonjour <strong style="color:#0f172a;">${safeCommerce}</strong>,<br />
            la carte <strong style="color:#0f172a;">${safeCard}</strong> est maintenant créée. Vous pouvez vérifier le rendu Wallet, partager le QR code client et installer le scanner équipe.
          </p>
          <div style="margin:22px 0 0;">
            <a href="${publicSiteUrl}/dashboard/carte" style="display:inline-block;border-radius:14px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">Voir ma carte</a>
            <a href="${publicSiteUrl}/dashboard/qr-client" style="display:inline-block;margin-left:10px;border-radius:14px;border:1px solid #bfdbfe;color:#1d4ed8;text-decoration:none;font-weight:800;padding:12px 18px;font-size:15px;">QR client</a>
          </div>
        </div>
        <div style="padding:18px 28px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Besoin d’aide ? Répondez à cet email ou contactez-nous à
            <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#2563eb;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: CardCreatedEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  return [
    `Bonjour ${input.commerceName},`,
    '',
    `Votre carte Fidelopass "${input.cardName}" est créée.`,
    `Voir la carte: ${publicSiteUrl}/dashboard/carte`,
    `QR client: ${publicSiteUrl}/dashboard/qr-client`,
    '',
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendCardCreatedEmail(input: CardCreatedEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[card-created-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || DEFAULT_CONTACT_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Fidelopass';

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: input.toEmail, name: input.commerceName }],
      replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || DEFAULT_CONTACT_EMAIL, name: 'Fidelopass' },
      subject: 'Votre carte Fidelopass est créée',
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['card', 'created'],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[card-created-email] Brevo error:', response.status, body);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
