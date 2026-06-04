import { getPublicSiteUrl } from '../utils/public-site-url';

type WelcomeEmailInput = {
  toEmail: string;
  commerceName?: string | null;
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

export function getWelcomeEmailSender() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || DEFAULT_CONTACT_EMAIL,
    name: process.env.BREVO_SENDER_NAME || 'Fidelopass',
    replyToEmail: process.env.BREVO_REPLY_TO_EMAIL || DEFAULT_CONTACT_EMAIL,
  };
}

function buildHtml(input: WelcomeEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const safeCommerce = htmlEscape(input.commerceName || 'votre commerce');

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">
      Bienvenue sur Fidelopass. Votre espace commerçant est prêt.
    </div>
    <div style="max-width:640px;margin:0 auto;padding:30px 16px 42px;">
      <div style="background:#ffffff;border:1px solid #dbeafe;border-radius:28px;overflow:hidden;box-shadow:0 26px 70px -42px rgba(15,23,42,.45);">
        <div style="padding:30px;background:#0f172a;background-image:linear-gradient(135deg,#0f172a 0%,#2563eb 62%,#38bdf8 100%);">
          <p style="margin:0;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#bfdbfe;font-weight:800;">Bienvenue</p>
          <h1 style="margin:14px 0 0;color:#ffffff;font-size:32px;line-height:1.12;font-weight:800;">
            Votre espace Fidelopass est prêt.
          </h1>
          <p style="margin:14px 0 0;color:#e0f2fe;font-size:15px;line-height:1.65;">
            Vous pouvez maintenant choisir votre plan, personnaliser votre carte et installer le scanner.
          </p>
        </div>

        <div style="padding:28px 30px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Bonjour <strong style="color:#0f172a;">${safeCommerce}</strong>,<br />
            merci d'avoir rejoint Fidelopass. En quelques minutes, votre carte de fidélité peut être prête dans Apple Wallet et Google Wallet.
          </p>

          <div style="margin:22px 0 0;display:block;">
            <a href="${publicSiteUrl}/dashboard/carte" style="display:inline-block;border-radius:14px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">
              Personnaliser ma carte
            </a>
            <a href="${publicSiteUrl}/abonnement/choix" style="display:inline-block;margin-left:10px;border-radius:14px;border:1px solid #bfdbfe;color:#1d4ed8;text-decoration:none;font-weight:800;padding:12px 18px;font-size:15px;">
              Choisir mon plan
            </a>
          </div>

          <div style="margin:26px 0 0;padding:18px;border:1px solid #dbeafe;background:#eff6ff;border-radius:18px;">
            <p style="margin:0;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#2563eb;font-weight:800;">Prochaines étapes</p>
            <ol style="margin:12px 0 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.75;">
              <li>Choisissez votre abonnement.</li>
              <li>Personnalisez les couleurs, la bannière et la récompense.</li>
              <li>Affichez le QR code en caisse pour que vos clients ajoutent la carte.</li>
            </ol>
          </div>
        </div>

        <div style="padding:18px 30px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Besoin d'aide ? Répondez à cet email ou contactez-nous à
            <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#2563eb;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
          <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;">Fidelopass - Cartes de fidélité digitales pour commerces exigeants</p>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: WelcomeEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const commerceName = input.commerceName || 'votre commerce';
  return [
    'Bienvenue sur Fidelopass',
    '',
    `Bonjour ${commerceName},`,
    '',
    'Votre espace commerçant est prêt.',
    'Vous pouvez maintenant choisir votre plan, personnaliser votre carte et installer le scanner.',
    '',
    `Personnaliser ma carte: ${publicSiteUrl}/dashboard/carte`,
    `Choisir mon plan: ${publicSiteUrl}/abonnement/choix`,
    '',
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendWelcomeEmail(input: WelcomeEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[welcome-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const sender = getWelcomeEmailSender();

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: sender.email, name: sender.name },
      to: [{ email: input.toEmail, name: input.commerceName || undefined }],
      replyTo: { email: sender.replyToEmail, name: 'Fidelopass' },
      subject: 'Bienvenue sur Fidelopass',
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['auth', 'welcome'],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('[welcome-email] Brevo error:', response.status, bodyText);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
