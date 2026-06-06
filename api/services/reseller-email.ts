import { getPublicSiteUrl } from '../utils/public-site-url';

type ResellerAccessEmailInput = {
  toEmail: string;
  brandName?: string | null;
  dashboardUrl?: string | null;
  publicLinkUrl?: string | null;
};

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_CONTACT_EMAIL = 'contact@duo-agency.com';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function emailSender() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || DEFAULT_CONTACT_EMAIL,
    name: process.env.BREVO_SENDER_NAME || 'Fidelopass',
    replyToEmail: process.env.BREVO_REPLY_TO_EMAIL || DEFAULT_CONTACT_EMAIL,
  };
}

function baseUrl() {
  return (getPublicSiteUrl() || process.env.PUBLIC_SITE_URL || 'https://www.fidelopass.com').replace(/\/$/, '');
}

function buildHtml(input: ResellerAccessEmailInput) {
  const dashboardUrl = input.dashboardUrl || `${baseUrl()}/reseller`;
  const brandName = escapeHtml(input.brandName || 'votre espace revendeur');
  const publicLink = input.publicLinkUrl
    ? `<p style="margin:14px 0 0;color:#334155;font-size:14px;line-height:1.6;">Votre lien public: <a href="${escapeHtml(input.publicLinkUrl)}" style="color:#2563eb;text-decoration:none;font-weight:800;">${escapeHtml(input.publicLinkUrl)}</a></p>`
    : '<p style="margin:14px 0 0;color:#334155;font-size:14px;line-height:1.6;">Vous pourrez configurer votre lien public depuis votre dashboard revendeur.</p>';

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;padding:30px 16px 42px;">
      <div style="background:#ffffff;border:1px solid #dbeafe;border-radius:28px;overflow:hidden;box-shadow:0 26px 70px -42px rgba(15,23,42,.45);">
        <div style="padding:30px;background:#0f172a;background-image:linear-gradient(135deg,#0f172a 0%,#2563eb 62%,#38bdf8 100%);">
          <p style="margin:0;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#bfdbfe;font-weight:800;">Programme revendeur</p>
          <h1 style="margin:14px 0 0;color:#ffffff;font-size:32px;line-height:1.12;font-weight:800;">Votre espace revendeur Fidelopass est prêt.</h1>
          <p style="margin:14px 0 0;color:#e0f2fe;font-size:15px;line-height:1.65;">Vous pouvez configurer votre lien, vos prix publics et suivre vos commerçants.</p>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Bonjour,<br />
            votre dossier <strong style="color:#0f172a;">${brandName}</strong> est disponible dans Fidelopass.
          </p>
          <div style="margin:22px 0 0;">
            <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;border-radius:14px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">
              Ouvrir mon dashboard revendeur
            </a>
          </div>
          ${publicLink}
          <div style="margin:24px 0 0;padding:18px;border:1px solid #dbeafe;background:#eff6ff;border-radius:18px;">
            <p style="margin:0;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#2563eb;font-weight:800;">À faire</p>
            <ol style="margin:12px 0 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.75;">
              <li>Vérifiez votre lien revendeur.</li>
              <li>Définissez vos prix publics au-dessus du minimum autorisé.</li>
              <li>Partagez le lien aux commerçants à inscrire.</li>
            </ol>
          </div>
        </div>
        <div style="padding:18px 30px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Besoin d'aide ? Répondez à cet email ou contactez-nous à
            <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#2563eb;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: ResellerAccessEmailInput) {
  const dashboardUrl = input.dashboardUrl || `${baseUrl()}/reseller`;
  return [
    'Votre espace revendeur Fidelopass est prêt.',
    '',
    `Dashboard revendeur: ${dashboardUrl}`,
    input.publicLinkUrl ? `Lien public: ${input.publicLinkUrl}` : 'Configurez votre lien public depuis le dashboard revendeur.',
    '',
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendResellerAccessEmail(input: ResellerAccessEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[reseller-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const sender = emailSender();
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: sender.email, name: sender.name },
      to: [{ email: input.toEmail, name: input.brandName || undefined }],
      replyTo: { email: sender.replyToEmail, name: 'Fidelopass' },
      subject: 'Votre espace revendeur Fidelopass est prêt',
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['reseller', 'access'],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('[reseller-email] Brevo error:', response.status, bodyText);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
