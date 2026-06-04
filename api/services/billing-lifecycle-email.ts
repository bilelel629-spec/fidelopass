import { getPublicSiteUrl } from '../utils/public-site-url';

type BillingLifecycleKind = 'payment_succeeded' | 'payment_failed' | 'subscription_canceled';

type BillingLifecycleEmailInput = {
  toEmail: string;
  commerceName: string;
  kind: BillingLifecycleKind;
  plan?: string | null;
  amountLabel?: string | null;
  nextBillingDate?: string | null;
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

function planLabel(plan?: string | null) {
  const normalized = String(plan ?? '').trim().toLowerCase();
  if (normalized === 'business') return 'Business';
  if (normalized === 'pro') return 'Pro';
  if (normalized === 'starter') return 'Starter';
  return 'Fidelopass';
}

function subject(kind: BillingLifecycleKind) {
  if (kind === 'payment_failed') return 'Action requise : paiement Fidelopass refusé';
  if (kind === 'subscription_canceled') return 'Votre abonnement Fidelopass est annulé';
  return 'Paiement Fidelopass confirmé';
}

function title(kind: BillingLifecycleKind) {
  if (kind === 'payment_failed') return 'Votre paiement n’a pas abouti';
  if (kind === 'subscription_canceled') return 'Abonnement annulé';
  return 'Paiement confirmé';
}

function body(input: BillingLifecycleEmailInput) {
  const plan = planLabel(input.plan);
  if (input.kind === 'payment_failed') {
    return `Le paiement de votre plan ${plan} n’a pas pu être validé. Mettez à jour votre moyen de paiement pour éviter une interruption de service.`;
  }
  if (input.kind === 'subscription_canceled') {
    return `Votre abonnement ${plan} a été annulé. Votre espace reste accessible selon les conditions de fin de période indiquées dans votre compte.`;
  }
  return `Nous avons bien reçu le paiement de votre plan ${plan}. Votre accès Fidelopass reste actif.`;
}

function buildHtml(input: BillingLifecycleEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const safeName = htmlEscape(input.commerceName || 'votre commerce');
  const safeTitle = htmlEscape(title(input.kind));
  const safeBody = htmlEscape(body(input));
  const safeAmount = input.amountLabel ? htmlEscape(input.amountLabel) : null;
  const safeNext = input.nextBillingDate ? htmlEscape(input.nextBillingDate) : null;
  const ctaLabel = input.kind === 'payment_failed' ? 'Mettre à jour le paiement' : 'Ouvrir mon compte';

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:620px;margin:0 auto;padding:28px 16px 40px;">
      <div style="background:#fff;border:1px solid #dbeafe;border-radius:24px;overflow:hidden;box-shadow:0 24px 48px -28px rgba(15,23,42,.25);">
        <div style="padding:28px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 64%,#0ea5e9 100%);">
          <p style="margin:0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#bfdbfe;font-weight:800;">Fidelopass</p>
          <h1 style="margin:12px 0 0;color:#fff;font-size:30px;line-height:1.1;font-weight:800;">${safeTitle}</h1>
        </div>
        <div style="padding:26px 28px;">
          <p style="margin:0;font-size:16px;line-height:1.65;color:#334155;">Bonjour <strong style="color:#0f172a;">${safeName}</strong>,</p>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.65;color:#334155;">${safeBody}</p>
          ${safeAmount || safeNext ? `
            <div style="margin:20px 0 0;padding:16px;border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;">
              ${safeAmount ? `<p style="margin:0;font-size:14px;color:#0f172a;"><strong>Montant :</strong> ${safeAmount}</p>` : ''}
              ${safeNext ? `<p style="margin:8px 0 0;font-size:14px;color:#0f172a;"><strong>Prochaine échéance :</strong> ${safeNext}</p>` : ''}
            </div>
          ` : ''}
          <a href="${publicSiteUrl}/dashboard/parametres" style="display:inline-block;margin-top:22px;border-radius:14px;background:#2563eb;color:#fff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:15px;">
            ${ctaLabel}
          </a>
        </div>
        <div style="padding:16px 28px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
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

function buildText(input: BillingLifecycleEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  return [
    title(input.kind),
    '',
    `Bonjour ${input.commerceName || 'votre commerce'},`,
    body(input),
    input.amountLabel ? `Montant: ${input.amountLabel}` : '',
    input.nextBillingDate ? `Prochaine échéance: ${input.nextBillingDate}` : '',
    '',
    `Mon compte: ${publicSiteUrl}/dashboard/parametres`,
    `Support: ${DEFAULT_CONTACT_EMAIL}`,
  ].filter(Boolean).join('\n');
}

export async function sendBillingLifecycleEmail(input: BillingLifecycleEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[billing-lifecycle-email] BREVO_API_KEY manquant, email ignoré');
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
      subject: subject(input.kind),
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['billing', input.kind],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('[billing-lifecycle-email] Brevo error:', response.status, bodyText);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
