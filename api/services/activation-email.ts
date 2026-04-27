import { getPublicSiteUrl } from '../utils/public-site-url';

type ActivationEmailInput = {
  toEmail: string;
  commerceName: string;
  plan: 'starter' | 'pro';
  billingStatus: 'trialing' | 'active';
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

function planLabel(plan: 'starter' | 'pro') {
  return plan === 'pro' ? 'Pro' : 'Starter';
}

function buildSubject(input: ActivationEmailInput) {
  const mode = input.billingStatus === 'trialing' ? 'essai' : 'abonnement';
  return `Votre ${mode} Fidelopass est activé`;
}

function buildHtml(input: ActivationEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const onboardingUrl = `${publicSiteUrl}/onboarding`;
  const cardEditorUrl = `${publicSiteUrl}/dashboard/carte`;
  const scannerUrl = `${publicSiteUrl}/app/install`;
  const qrShareUrl = `${publicSiteUrl}/dashboard/qr-client`;

  const safeName = htmlEscape(input.commerceName || 'votre commerce');
  const safePlan = htmlEscape(planLabel(input.plan));
  const modeLabel = input.billingStatus === 'trialing' ? 'Essai gratuit activé' : 'Abonnement activé';

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 18px 40px;">
      <div style="background:linear-gradient(135deg,#ffffff 0%,#f5f9ff 65%,#eff6ff 100%);border:1px solid #dbeafe;border-radius:24px;overflow:hidden;box-shadow:0 24px 48px -26px rgba(15,23,42,.22);">
        <div style="padding:28px 28px 20px;background:linear-gradient(135deg,#0f172a 0%,#312e81 58%,#0284c7 100%);">
          <img src="${publicSiteUrl}/logo-premium-cropped.png" alt="Fidelopass" style="height:48px;width:auto;display:block;" />
          <p style="margin:16px 0 0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#bfdbfe;font-weight:600;">Activation confirmée</p>
          <h1 style="margin:10px 0 0;color:#fff;font-size:30px;line-height:1.1;font-weight:800;">
            Votre accès Fidelopass est prêt.
          </h1>
        </div>

        <div style="padding:26px 28px 8px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">
            Bonjour <strong style="color:#0f172a;">${safeName}</strong>,<br />
            ${modeLabel} sur le plan <strong style="color:#0f172a;">${safePlan}</strong>.
            Vous pouvez maintenant profiter de Fidelopass pour faire revenir vos clients.
          </p>

          <div style="margin:18px 0 0;padding:14px 16px;border:1px solid #bae6fd;background:#f0f9ff;border-radius:14px;">
            <p style="margin:0;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#0369a1;font-weight:700;">Prochaine étape</p>
            <p style="margin:8px 0 0;font-size:14px;color:#0f172a;line-height:1.6;">
              1. Créer votre carte fidélité<br />
              2. Installer le scanner équipe<br />
              3. Partager votre QR code en magasin
            </p>
          </div>
        </div>

        <div style="padding:14px 28px 22px;">
          <a href="${cardEditorUrl}" style="display:inline-block;border-radius:14px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;font-size:15px;box-shadow:0 16px 32px -18px rgba(37,99,235,.7);">
            Créer ma carte maintenant
          </a>
        </div>

        <div style="padding:0 28px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;border-top:1px solid #e2e8f0;">
                <a href="${onboardingUrl}" style="font-size:13px;color:#334155;text-decoration:none;">Finaliser l’onboarding</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-top:1px solid #e2e8f0;">
                <a href="${scannerUrl}" style="font-size:13px;color:#334155;text-decoration:none;">Configurer le scanner équipe</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
                <a href="${qrShareUrl}" style="font-size:13px;color:#334155;text-decoration:none;">Afficher le QR client</a>
              </td>
            </tr>
          </table>
        </div>

        <div style="padding:14px 28px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.7;">
            Besoin d’aide ? Répondez à cet email ou contactez-nous à
            <a href="mailto:${DEFAULT_CONTACT_EMAIL}" style="color:#1d4ed8;text-decoration:none;">${DEFAULT_CONTACT_EMAIL}</a>.
          </p>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: ActivationEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const modeLabel = input.billingStatus === 'trialing' ? 'essai gratuit activé' : 'abonnement activé';
  return [
    `Bonjour ${input.commerceName},`,
    '',
    `Votre ${modeLabel} sur Fidelopass (plan ${planLabel(input.plan)}) est confirmé.`,
    'Vous pouvez maintenant utiliser Fidelopass pour faire revenir vos clients.',
    '',
    'Prochaines étapes :',
    `1) Créer la carte : ${publicSiteUrl}/dashboard/carte`,
    `2) Installer le scanner équipe : ${publicSiteUrl}/app/install`,
    `3) Partager le QR code client : ${publicSiteUrl}/dashboard/qr-client`,
    '',
    `Support : ${DEFAULT_CONTACT_EMAIL}`,
  ].join('\n');
}

export async function sendActivationEmail(input: ActivationEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[activation-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || DEFAULT_CONTACT_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Fidelopass';

  const payload = {
    sender: {
      email: senderEmail,
      name: senderName,
    },
    to: [{ email: input.toEmail, name: input.commerceName }],
    subject: buildSubject(input),
    htmlContent: buildHtml(input),
    textContent: buildText(input),
    tags: ['subscription', 'activation'],
  };

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[activation-email] Brevo error:', response.status, body);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
