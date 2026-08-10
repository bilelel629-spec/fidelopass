import { getPublicSiteUrl } from '../utils/public-site-url';

type TeamAccessRole = 'admin' | 'staff';

type TeamAccessEmailInput = {
  toEmail: string;
  commerceName?: string | null;
  role?: TeamAccessRole | null;
  invitedByEmail?: string | null;
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

function getSender() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || DEFAULT_CONTACT_EMAIL,
    name: process.env.BREVO_SENDER_NAME || 'Fidelopass',
    replyToEmail: process.env.BREVO_REPLY_TO_EMAIL || DEFAULT_CONTACT_EMAIL,
  };
}

function getDashboardUrl() {
  const publicSiteUrl = (getPublicSiteUrl() || process.env.PUBLIC_SITE_URL || 'https://www.fidelopass.com').replace(/\/$/, '');
  return `${publicSiteUrl}/dashboard`;
}

function getRoleLabel(role?: TeamAccessRole | null) {
  return role === 'admin' ? 'Administrateur' : 'Équipe';
}

export function buildTeamAccessEmailHtml(input: TeamAccessEmailInput) {
  const commerceName = htmlEscape(input.commerceName || 'votre commerce');
  const dashboardUrl = getDashboardUrl();
  const roleLabel = htmlEscape(getRoleLabel(input.role));
  const invitedBy = input.invitedByEmail
    ? `<p style="margin:14px 0 0;color:#64748b;font-size:13px;line-height:1.6;">Invitation ajoutée par ${htmlEscape(input.invitedByEmail)}.</p>`
    : '';

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;opacity:0;">
      Vous avez maintenant accès à l’espace commerçant ${commerceName} sur Fidelopass.
    </div>
    <div style="max-width:640px;margin:0 auto;padding:30px 16px 42px;">
      <div style="background:#ffffff;border:1px solid #dbeafe;border-radius:28px;overflow:hidden;box-shadow:0 26px 70px -42px rgba(15,23,42,.45);">
        <div style="padding:30px;background:#0f172a;background-image:linear-gradient(135deg,#0f172a 0%,#2563eb 62%,#38bdf8 100%);">
          <p style="margin:0;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#bfdbfe;font-weight:800;">Accès équipe</p>
          <h1 style="margin:14px 0 0;color:#ffffff;font-size:32px;line-height:1.12;font-weight:800;">
            Vous avez accès à ${commerceName}.
          </h1>
          <p style="margin:14px 0 0;color:#e0f2fe;font-size:15px;line-height:1.65;">
            Connectez-vous à Fidelopass pour gérer la carte, scanner les clients et suivre l’activité selon vos droits.
          </p>
        </div>

        <div style="padding:28px 30px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Bonjour,<br />
            un accès équipe vient de vous être accordé sur le commerce
            <strong style="color:#0f172a;">${commerceName}</strong>.
          </p>

          <div style="margin:22px 0 0;padding:18px;border:1px solid #dbeafe;background:#eff6ff;border-radius:18px;">
            <p style="margin:0;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#2563eb;font-weight:800;">Votre accès</p>
            <p style="margin:12px 0 0;font-size:18px;line-height:1.45;color:#0f172a;font-weight:800;">Rôle : ${roleLabel}</p>
            <p style="margin:8px 0 0;font-size:14px;line-height:1.65;color:#475569;">
              Utilisez votre email et votre mot de passe Fidelopass pour vous connecter. Si vous n’avez pas encore défini de mot de passe, utilisez “Mot de passe oublié” sur la page de connexion.
            </p>
            ${invitedBy}
          </div>

          <div style="margin:24px 0 0;">
            <a href="${dashboardUrl}" style="display:inline-block;border-radius:14px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">
              Ouvrir Fidelopass
            </a>
          </div>

          <div style="margin:26px 0 0;padding:16px;border:1px solid #fde68a;background:#fffbeb;border-radius:16px;">
            <p style="margin:0;font-size:13px;color:#78350f;line-height:1.6;">
              Cet accès est réservé à votre équipe. Ne partagez pas vos identifiants.
            </p>
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

export function buildTeamAccessEmailText(input: TeamAccessEmailInput) {
  const commerceName = input.commerceName || 'votre commerce';
  return [
    'Accès équipe Fidelopass',
    '',
    `Vous avez maintenant accès au commerce ${commerceName}.`,
    `Rôle: ${getRoleLabel(input.role)}`,
    '',
    'Connectez-vous avec votre email et votre mot de passe Fidelopass.',
    'Si vous n’avez pas encore défini de mot de passe, utilisez “Mot de passe oublié” sur la page de connexion.',
    '',
    `Ouvrir Fidelopass: ${getDashboardUrl()}`,
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendTeamAccessEmail(input: TeamAccessEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[team-access-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const sender = getSender();
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: sender.email, name: sender.name },
      to: [{ email: input.toEmail }],
      replyTo: { email: sender.replyToEmail, name: 'Fidelopass' },
      subject: `Accès équipe Fidelopass - ${input.commerceName || 'votre commerce'}`,
      htmlContent: buildTeamAccessEmailHtml(input),
      textContent: buildTeamAccessEmailText(input),
      tags: ['commerce', 'team-access'],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('[team-access-email] Brevo error:', response.status, bodyText);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
