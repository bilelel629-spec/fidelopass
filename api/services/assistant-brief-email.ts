import { getPublicSiteUrl } from '../utils/public-site-url';

type AssistantBriefFile = {
  type?: string | null;
  label?: string | null;
  url?: string | null;
};

type AssistantBriefEmailInput = {
  commerceName: string;
  commerceEmail?: string | null;
  pointVenteName?: string | null;
  brief: {
    business_name: string;
    sector?: string | null;
    desired_style?: string | null;
    preferred_colors?: string | null;
    reward_details?: string | null;
    logo_url?: string | null;
    inspiration_url?: string | null;
    files?: AssistantBriefFile[] | null;
    notes?: string | null;
  };
};

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_CONTACT_EMAIL = 'contact@duo-agency.com';
const DEFAULT_BRIEF_RECIPIENT = 'bilelel629@gmail.com';

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function nullable(value: string | null | undefined) {
  const text = String(value ?? '').trim();
  return text.length ? text : 'Non renseigné';
}

function field(label: string, value: string | null | undefined) {
  return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;width:34%;">${htmlEscape(label)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;font-weight:600;">${htmlEscape(nullable(value))}</td>
    </tr>
  `;
}

function linkField(label: string, value: string | null | undefined) {
  const text = String(value ?? '').trim();
  const content = text
    ? `<a href="${htmlEscape(text)}" style="color:#2563eb;text-decoration:none;">${htmlEscape(text)}</a>`
    : 'Non renseigné';
  return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;width:34%;">${htmlEscape(label)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;font-weight:600;">${content}</td>
    </tr>
  `;
}

function buildFilesHtml(files: AssistantBriefFile[] | null | undefined) {
  const validFiles = (files ?? []).filter((file) => String(file?.url ?? '').trim());
  if (!validFiles.length) return '<p style="margin:0;color:#64748b;font-size:14px;">Aucun fichier supplémentaire.</p>';

  return `
    <ul style="margin:0;padding-left:18px;color:#0f172a;font-size:14px;line-height:1.8;">
      ${validFiles.map((file) => {
        const label = file.label || file.type || 'Fichier';
        const url = String(file.url);
        return `<li><strong>${htmlEscape(label)}</strong> — <a href="${htmlEscape(url)}" style="color:#2563eb;text-decoration:none;">ouvrir</a></li>`;
      }).join('')}
    </ul>
  `;
}

function buildHtml(input: AssistantBriefEmailInput) {
  const publicSiteUrl = (getPublicSiteUrl() || 'https://www.fidelopass.com').replace(/\/$/, '');
  const adminUrl = `${publicSiteUrl}/admin/cartes`;
  const brief = input.brief;

  return `
  <div style="margin:0;padding:0;background:#f8fbff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:720px;margin:0 auto;padding:28px 18px 40px;">
      <div style="border:1px solid #dbeafe;border-radius:24px;overflow:hidden;background:#ffffff;box-shadow:0 24px 54px -32px rgba(15,23,42,.28);">
        <div style="padding:26px 28px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 58%,#06b6d4 100%);">
          <img src="${publicSiteUrl}/logo-premium-cropped.png" alt="Fidelopass" style="height:42px;width:auto;display:block;" />
          <p style="margin:16px 0 0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#bfdbfe;font-weight:800;">Nouveau brief design</p>
          <h1 style="margin:8px 0 0;color:#fff;font-size:28px;line-height:1.15;font-weight:800;">
            ${htmlEscape(brief.business_name || input.commerceName)}
          </h1>
        </div>
        <div style="padding:24px 28px;">
          <p style="margin:0 0 18px;color:#334155;font-size:15px;line-height:1.7;">
            Un commerçant vient d’envoyer son brief d’accompagnement carte. Voici les informations à reprendre côté admin.
          </p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            ${field('Commerce compte', input.commerceName)}
            ${field('Point de vente', input.pointVenteName)}
            ${field('Email commerce', input.commerceEmail)}
            ${field('Nom à afficher', brief.business_name)}
            ${field('Secteur', brief.sector)}
            ${field('Couleurs souhaitées', brief.preferred_colors)}
            ${field('Récompense', brief.reward_details)}
            ${field('Style recherché', brief.desired_style)}
            ${linkField('Logo', brief.logo_url)}
            ${linkField('Inspiration', brief.inspiration_url)}
            ${field('Notes', brief.notes)}
          </table>
          <div style="margin-top:20px;padding:16px;border:1px solid #e0e7ff;background:#f8fbff;border-radius:16px;">
            <p style="margin:0 0 10px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#2563eb;font-weight:800;">Fichiers</p>
            ${buildFilesHtml(brief.files)}
          </div>
          <a href="${adminUrl}" style="display:inline-block;margin-top:20px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;text-decoration:none;font-weight:800;padding:13px 20px;font-size:14px;">
            Ouvrir l’assistance cartes
          </a>
        </div>
      </div>
    </div>
  </div>
  `.trim();
}

function buildText(input: AssistantBriefEmailInput) {
  const brief = input.brief;
  const files = (brief.files ?? [])
    .filter((file) => String(file?.url ?? '').trim())
    .map((file) => `- ${file.label || file.type || 'Fichier'}: ${file.url}`)
    .join('\n');

  return [
    'Nouveau brief design Fidelopass',
    '',
    `Commerce compte: ${nullable(input.commerceName)}`,
    `Point de vente: ${nullable(input.pointVenteName)}`,
    `Email commerce: ${nullable(input.commerceEmail)}`,
    `Nom à afficher: ${nullable(brief.business_name)}`,
    `Secteur: ${nullable(brief.sector)}`,
    `Couleurs: ${nullable(brief.preferred_colors)}`,
    `Récompense: ${nullable(brief.reward_details)}`,
    `Style: ${nullable(brief.desired_style)}`,
    `Logo: ${nullable(brief.logo_url)}`,
    `Inspiration: ${nullable(brief.inspiration_url)}`,
    `Notes: ${nullable(brief.notes)}`,
    '',
    'Fichiers:',
    files || 'Aucun fichier supplémentaire.',
  ].join('\n');
}

export async function sendAssistantBriefEmail(input: AssistantBriefEmailInput) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[assistant-brief-email] BREVO_API_KEY manquant, email ignoré');
    return { ok: false, skipped: true, reason: 'missing_api_key' as const };
  }

  const recipient = process.env.ASSISTANT_BRIEF_RECIPIENT_EMAIL || DEFAULT_BRIEF_RECIPIENT;
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
      to: [{ email: recipient, name: 'Fidelopass Admin' }],
      replyTo: input.commerceEmail ? { email: input.commerceEmail, name: input.commerceName } : undefined,
      subject: `Nouveau brief design — ${input.brief.business_name || input.commerceName}`,
      htmlContent: buildHtml(input),
      textContent: buildText(input),
      tags: ['assistant-brief'],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[assistant-brief-email] Brevo error:', response.status, body);
    return { ok: false, skipped: false, reason: 'provider_error' as const };
  }

  return { ok: true, skipped: false };
}
