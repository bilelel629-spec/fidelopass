import { getPublicSiteUrl } from '../utils/public-site-url';

type RegistrationEmailInput = {
  toEmail: string;
  code: string;
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
  const safeCode = htmlEscape(input.code);

  return `
  <div style="margin:0;padding:0;background:#eef6ff;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">
      Votre code de confirmation Fidelopass est ${safeCode}. Il expire rapidement.
    </div>
    <div style="max-width:640px;margin:0 auto;padding:32px 16px 42px;">
      <div style="background:#ffffff;border:1px solid #dbeafe;border-radius:28px;overflow:hidden;box-shadow:0 26px 70px -42px rgba(15,23,42,.45);">
        <div style="padding:30px 30px 28px;background:#0f172a;background-image:linear-gradient(135deg,#0f172a 0%,#1d4ed8 62%,#0ea5e9 100%);">
          <p style="margin:0;font-size:13px;letter-spacing:.24em;text-transform:uppercase;color:#dbeafe;font-weight:800;">Fidelopass</p>
          <h1 style="margin:14px 0 0;color:#ffffff;font-size:32px;line-height:1.12;font-weight:800;">
            Activez votre compte commerçant
          </h1>
          <p style="margin:14px 0 0;color:#e0f2fe;font-size:15px;line-height:1.65;">
            Saisissez ce code dans Fidelopass pour confirmer votre adresse email et terminer votre inscription.
          </p>
        </div>

        <div style="padding:30px;">
          <p style="margin:0;font-size:15px;line-height:1.65;color:#334155;">
            Compte concerné : <strong style="color:#0f172a;">${safeEmail}</strong>
          </p>

          <div style="margin:22px 0 0;padding:22px;border:1px solid #bfdbfe;background:#f8fbff;border-radius:20px;text-align:center;">
            <p style="margin:0 0 12px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#2563eb;font-weight:800;">
              Code de confirmation
            </p>
            <p style="margin:0;color:#0f172a;font-size:42px;line-height:1;font-weight:800;letter-spacing:.18em;">
              ${safeCode}
            </p>
          </div>

          <a href="${publicSiteUrl}/register" style="display:inline-block;margin:24px 0 0;border-radius:14px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">
            Retourner à l’inscription
          </a>

          <div style="margin:26px 0 0;padding:16px;border:1px solid #fde68a;background:#fffbeb;border-radius:16px;">
            <p style="margin:0;font-size:13px;color:#78350f;line-height:1.6;">
              Ce code est personnel et temporaire. Ne le partagez avec personne.
            </p>
          </div>
        </div>

        <div style="padding:18px 30px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Si vous n’êtes pas à l’origine de cette inscription, ignorez simplement cet email.
            Besoin d’aide ? Écrivez-nous à <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#2563eb;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
          <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;">Fidelopass • Cartes de fidélité digitales pour commerces exigeants</p>
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
    `Code de confirmation: ${input.code}`,
    '',
    'Copiez ce code dans l’écran Fidelopass pour finaliser votre inscription.',
    '',
    'Ce code est personnel et temporaire. Ne le partagez avec personne.',
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
      replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || DEFAULT_CONTACT_EMAIL, name: 'Fidelopass' },
      subject: `${input.code} est votre code Fidelopass`,
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
