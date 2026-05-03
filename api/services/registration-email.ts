import { getPublicSiteUrl } from '../utils/public-site-url';

type RegistrationEmailInput = {
  toEmail: string;
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

function buildHtml(input: RegistrationEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const safeEmail = htmlEscape(input.toEmail);

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 18px 40px;">
      <div style="background:linear-gradient(135deg,#ffffff 0%,#f5f9ff 68%,#eef7ff 100%);border:1px solid #dbeafe;border-radius:24px;overflow:hidden;box-shadow:0 24px 48px -26px rgba(15,23,42,.22);">
        <div style="padding:28px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 60%,#06b6d4 100%);">
          <img src="${publicSiteUrl}/logo-premium-cropped.png" alt="Fidelopass" style="height:48px;width:auto;display:block;" />
          <p style="margin:18px 0 0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#bfdbfe;font-weight:700;">Inscription en cours</p>
          <h1 style="margin:10px 0 0;color:#fff;font-size:30px;line-height:1.1;font-weight:800;">
            Confirmez votre email pour activer Fidelopass.
          </h1>
        </div>

        <div style="padding:26px 28px 8px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Nous avons lancé la création du compte <strong style="color:#0f172a;">${safeEmail}</strong>.
            Copiez le code reçu par email dans l’écran Fidelopass pour finaliser l’inscription.
          </p>

          <div style="margin:18px 0 0;padding:16px;border:1px solid #bae6fd;background:#f0f9ff;border-radius:16px;">
            <p style="margin:0;font-size:13px;color:#0369a1;font-weight:800;">Astuce importante</p>
            <p style="margin:8px 0 0;font-size:14px;color:#0f172a;line-height:1.6;">
              Si le code arrive dans les indésirables, déplacez l’email dans votre boîte principale.
              Cela aide les prochains emails Fidelopass à arriver au bon endroit.
            </p>
          </div>
        </div>

        <div style="padding:14px 28px 26px;">
          <a href="${publicSiteUrl}/register" style="display:inline-block;border-radius:14px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;text-decoration:none;font-weight:800;padding:13px 22px;font-size:15px;box-shadow:0 16px 32px -18px rgba(37,99,235,.7);">
            Retourner à l’inscription
          </a>
        </div>

        <div style="padding:14px 28px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Besoin d’aide ? Contactez-nous à
            <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#1d4ed8;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: RegistrationEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  return [
    'Inscription Fidelopass en cours',
    '',
    `Compte: ${input.toEmail}`,
    'Copiez le code reçu par email dans l’écran Fidelopass pour finaliser votre inscription.',
    '',
    'Si le code arrive dans les indésirables, déplacez l’email dans votre boîte principale.',
    `Retour inscription: ${publicSiteUrl}/register`,
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendRegistrationEmail(input: RegistrationEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[registration-email] BREVO_API_KEY manquant, email ignoré');
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
      to: [{ email: input.toEmail }],
      subject: 'Votre inscription Fidelopass est lancée',
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['auth', 'registration'],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[registration-email] Brevo error:', response.status, body);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
