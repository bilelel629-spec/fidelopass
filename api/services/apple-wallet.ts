import { PKPass } from 'passkit-generator';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { connect } from 'http2';
import sharp from 'sharp';
import { generatePassBackgroundImage, generateStripImage } from './strip-generator';

interface CarteData {
  id: string;
  nom: string;
  type: 'points' | 'tampons';
  tampons_total: number;
  points_recompense: number;
  recompense_description: string | null;
  couleur_fond: string;
  couleur_texte: string;
  couleur_accent: string;
  push_icon_bg_color?: string | null;
  message_geo: string;
  logo_url?: string | null;
  strip_url?: string | null;
  strip_position?: string | null;
  tampon_icon_url?: string | null;
  barcode_type?: string | null;
  label_client?: string | null;
  couleur_fond_2?: string | null;
  gradient_angle?: number | null;
  pattern_type?: string | null;
  tampon_emoji?: string | null;
  strip_layout?: string | null;
  branding_powered_by_enabled?: boolean | null;
  google_maps_url?: string | null;
  rewards_config?: Array<{ seuil: number; recompense: string }> | null;
  vip_tiers?: Array<{ nom: string; seuil: number; avantage?: string }> | null;
  commerces: {
    nom: string;
    logo_url: string | null;
    latitude: number | null;
    longitude: number | null;
    rayon_geo: number;
    plan?: string | null;
  };
}

interface ClientData {
  id: string;
  nom: string | null;
  points_actuels: number;
  tampons_actuels: number;
  recompenses_obtenues?: number;
}

interface WalletMessage {
  titre: string;
  message: string;
}

function isProPlan(plan: string | null | undefined): boolean {
  const normalized = String(plan ?? 'starter').trim().toLowerCase();
  return normalized === 'pro' || normalized.startsWith('pro-') || normalized.includes('pro');
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function isHexColor(value: string | null | undefined): value is string {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? ''));
}

function hexToSharpColor(hex: string, alpha = 1): { r: number; g: number; b: number; alpha: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
    alpha,
  };
}

function readAsset(filename: string): Buffer {
  const path = resolve(process.cwd(), 'assets/pass', filename);
  if (!existsSync(path)) {
    throw new Error(`Asset manquant : ${path}`);
  }
  return readFileSync(path);
}

function readSecretFileOrEnv(filename: string, envName: string): Buffer {
  const envValue = process.env[envName];
  if (envValue) {
    return Buffer.from(envValue.replace(/\\n/g, '\n'));
  }

  return readFileSync(resolve(process.cwd(), 'certs', filename));
}

function getAppleWebServiceUrl(): string | null {
  const explicit = process.env.APPLE_WEB_SERVICE_URL ?? process.env.API_URL ?? process.env.PUBLIC_API_URL;
  if (explicit) {
    const url = explicit.replace(/\/$/, '');
    return url.endsWith('/api/wallet/apple') ? url : `${url}/api/wallet/apple`;
  }

  const appUrl = process.env.APP_URL?.replace(/\/$/, '');
  if (!appUrl?.startsWith('https://')) return null;

  return `${appUrl.replace('https://www.', 'https://api.').replace('https://fidelopass.com', 'https://api.fidelopass.com')}/api/wallet/apple`;
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

async function resizeTo(buf: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'centre' }).png().toBuffer();
}

async function createPassIcon(buf: Buffer, size: number, backgroundHex: string): Promise<Buffer> {
  const padding = Math.max(2, Math.round(size * 0.06));
  const inner = Math.max(1, size - padding * 2);
  const trimmed = await sharp(buf)
    .trim()
    .png()
    .toBuffer();

  const contained = await sharp(trimmed)
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: hexToSharpColor(backgroundHex),
    },
  })
    .composite([{ input: contained, gravity: 'centre' }])
    .png()
    .toBuffer();
}

const BARCODE_FORMAT_MAP: Record<string, string> = {
  QR: 'PKBarcodeFormatQR',
  PDF417: 'PKBarcodeFormatPDF417',
  AZTEC: 'PKBarcodeFormatAztec',
  CODE128: 'PKBarcodeFormatCode128',
};

export async function generateApplePass(
  carte: CarteData,
  client: ClientData,
  walletMessage?: WalletMessage | null,
): Promise<Buffer> {
  const barcodeType = carte.barcode_type ?? 'QR';
  const labelClient = carte.label_client ?? 'Client';

  const soldeLabel = carte.type === 'tampons' ? 'Tampons' : 'Points';
  const soldeValue = carte.type === 'tampons'
    ? `${client.tampons_actuels}/${carte.tampons_total}`
    : String(client.points_actuels);
  const rewardsText = (carte.rewards_config ?? [])
    .filter((reward) => reward?.seuil && reward?.recompense)
    .map((reward) => `${reward.seuil} ${carte.type === 'tampons' ? 'tampons' : 'points'} : ${reward.recompense}`)
    .join('\n');
  const vipText = (carte.vip_tiers ?? [])
    .filter((tier) => tier?.nom && tier?.seuil)
    .map((tier) => `${tier.nom} : ${tier.seuil} points${tier.avantage ? ` — ${tier.avantage}` : ''}`)
    .join('\n');

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
    teamIdentifier: process.env.APPLE_TEAM_ID,
    serialNumber: client.id,
    organizationName: carte.commerces.nom,
    description: carte.nom,
    foregroundColor: hexToRgb(carte.couleur_texte),
    backgroundColor: hexToRgb(carte.couleur_fond),
    labelColor: hexToRgb(carte.couleur_accent),
    logoText: carte.nom,
    authenticationToken: client.id,
    storeCard: {
      // headerFields : coin supérieur droit (solde)
      headerFields: [
        {
          key: 'solde',
          label: soldeLabel.toUpperCase(),
          value: soldeValue,
          changeMessage: `Votre solde ${soldeLabel.toLowerCase()} est maintenant %@.`,
        },
      ],
      // primaryFields : zone sur la strip — on laisse vide pour ne rien superposer
      primaryFields: [],
      // secondaryFields : juste sous la strip — nom du client
      secondaryFields: [
        {
          key: 'client',
          label: labelClient.toUpperCase(),
          value: client.nom ?? 'Fidèle client',
        },
      ],
      // auxiliaryFields : ligne sous les secondaryFields (max 2 sur storeCard)
      auxiliaryFields: [
        {
          key: 'recompense',
          label: 'Récompense',
          value: carte.recompense_description ?? '—',
          changeMessage: 'Votre récompense Fidelopass a été mise à jour.',
        },
        {
          key: 'recompenses_disponibles',
          label: 'Récompenses dispo',
          value: String(client.recompenses_obtenues ?? 0),
          changeMessage: 'Récompenses disponibles : %@.',
        },
      ],
      backFields: [
        {
          key: 'programme',
          label: 'Programme',
          value: carte.nom,
        },
        {
          key: 'conditions',
          label: 'Conditions',
          value: `Présentez cette carte à chaque visite pour cumuler vos ${soldeLabel.toLowerCase()}.`,
        },
        ...(rewardsText ? [{
          key: 'recompenses_multiples',
          label: 'Récompenses',
          value: rewardsText,
        }] : []),
        ...(vipText ? [{
          key: 'paliers_vip',
          label: 'Paliers VIP',
          value: vipText,
        }] : []),
        ...(carte.google_maps_url ? [{
          key: 'avis_google_back',
          label: 'Laisser un avis Google',
          value: carte.google_maps_url,
          attributedValue: `<a href='${carte.google_maps_url}'>Laisser un avis Google ⭐</a>`,
        }] : []),
        ...(walletMessage?.message ? [{
          key: 'message_wallet',
          label: walletMessage.titre || 'Message',
          value: walletMessage.message,
          changeMessage: `${walletMessage.titre || 'Nouveau message'} : %@`,
        }] : []),
      ],
    },
  };

  const webServiceURL = getAppleWebServiceUrl();
  if (webServiceURL) {
    passJson.webServiceURL = webServiceURL;
  }

  const showBranding = isProPlan(carte.commerces.plan)
    ? carte.branding_powered_by_enabled !== false
    : true;

  // Code-barres
  if (barcodeType !== 'NONE') {
    const format = BARCODE_FORMAT_MAP[barcodeType] ?? 'PKBarcodeFormatQR';
    const brandingAltText = showBranding ? 'Powered by Fidelopass' : undefined;
    passJson.barcode = {
      message: client.id,
      format,
      messageEncoding: 'iso-8859-1',
      ...(brandingAltText ? { altText: brandingAltText } : {}),
    };
    passJson.barcodes = [{
      message: client.id,
      format,
      messageEncoding: 'iso-8859-1',
      ...(brandingAltText ? { altText: brandingAltText } : {}),
    }];
  }

  // Géolocalisation
  if (carte.commerces.latitude && carte.commerces.longitude) {
    passJson.locations = [{
      latitude: carte.commerces.latitude,
      longitude: carte.commerces.longitude,
      relevantText: carte.message_geo,
      maxDistance: carte.commerces.rayon_geo,
    }];
  }

  // ── Génération de la strip (image bannière avec tampons) ──────────
  const stripBuffer = await generateStripImage({
    type: carte.type,
    tamponsActuels: client.tampons_actuels,
    tamponsTotal: carte.tampons_total,
    couleurFond: carte.couleur_fond,
    couleurAccent: carte.couleur_accent,
    stripImageUrl: carte.strip_url,
    stripPosition: carte.strip_position ?? 'center',
    tamponIconUrl: carte.tampon_icon_url,
    couleurFond2: carte.couleur_fond_2,
    gradientAngle: carte.gradient_angle,
    patternType: carte.pattern_type,
    tamponEmoji: carte.tampon_emoji,
    stripLayout: carte.strip_layout,
    showBranding: false,
  });
  const background2x = await generatePassBackgroundImage({
    couleurFond: carte.couleur_fond,
    couleurAccent: carte.couleur_accent,
    couleurFond2: carte.couleur_fond_2,
    gradientAngle: carte.gradient_angle,
    patternType: carte.pattern_type,
    width: 360,
    height: 440,
  });

  // ── Logo ──────────────────────────────────────────────────────────
  const logoUrl = carte.logo_url ?? carte.commerces.logo_url;
  const logoRaw = logoUrl ? await fetchImageBuffer(logoUrl) : null;
  const logo1x = logoRaw ? await resizeTo(logoRaw, 120, 120) : readAsset('logo.png');
  const logo2x = logoRaw ? await resizeTo(logoRaw, 240, 240) : readAsset('logo@2x.png');
  // iOS 15+ affiche une icône de notification Wallet plus grande.
  // Apple recommande maintenant 38x38 minimum à l'échelle 1x.
  const iconBgColor = isHexColor(carte.push_icon_bg_color)
    ? carte.push_icon_bg_color
    : (isHexColor(carte.couleur_accent) ? carte.couleur_accent : '#6366f1');
  const icon1x = logoRaw ? await createPassIcon(logoRaw, 38, iconBgColor) : await resizeTo(readAsset('icon@3x.png'), 38, 38);
  const icon2x = logoRaw ? await createPassIcon(logoRaw, 76, iconBgColor) : await resizeTo(readAsset('icon@3x.png'), 76, 76);
  const icon3x = logoRaw ? await createPassIcon(logoRaw, 114, iconBgColor) : await resizeTo(readAsset('icon@3x.png'), 114, 114);

  // ── Dossier temporaire .pass ──────────────────────────────────────
  const tmpPassDir = resolve(tmpdir(), `fidelopass-${randomUUID()}.pass`);
  mkdirSync(tmpPassDir, { recursive: true });

  try {
    writeFileSync(resolve(tmpPassDir, 'pass.json'), JSON.stringify(passJson));

    writeFileSync(resolve(tmpPassDir, 'icon.png'), icon1x);
    writeFileSync(resolve(tmpPassDir, 'icon@2x.png'), icon2x);
    writeFileSync(resolve(tmpPassDir, 'icon@3x.png'), icon3x);

    writeFileSync(resolve(tmpPassDir, 'logo.png'), logo1x);
    writeFileSync(resolve(tmpPassDir, 'logo@2x.png'), logo2x);

    // strip.png = image générée dynamiquement (tampons ou bannière)
    const strip1x = await sharp(stripBuffer).resize(375, 123, { fit: 'cover' }).png().toBuffer();
    writeFileSync(resolve(tmpPassDir, 'strip.png'), strip1x);
    writeFileSync(resolve(tmpPassDir, 'strip@2x.png'), stripBuffer);
    const background1x = await sharp(background2x).resize(180, 220, { fit: 'cover' }).png().toBuffer();
    const background3x = await sharp(background2x).resize(540, 660, { fit: 'cover' }).png().toBuffer();
    writeFileSync(resolve(tmpPassDir, 'background.png'), background1x);
    writeFileSync(resolve(tmpPassDir, 'background@2x.png'), background2x);
    writeFileSync(resolve(tmpPassDir, 'background@3x.png'), background3x);

    const pass = await PKPass.from(
      {
        model: tmpPassDir,
        certificates: {
          wwdr: readSecretFileOrEnv('wwdr.pem', 'APPLE_WWDR_PEM'),
          signerCert: readSecretFileOrEnv('signer.pem', 'APPLE_SIGNER_CERT_PEM'),
          signerKey: readSecretFileOrEnv('key.pem', 'APPLE_SIGNER_KEY_PEM'),
        },
      },
      {},
    );

    return pass.getAsBuffer();
  } finally {
    rmSync(tmpPassDir, { recursive: true, force: true });
  }
}

/**
 * Envoie un push silencieux APNs pour déclencher le rafraîchissement d'un pass Wallet.
 *
 * Mécanisme Apple Wallet (spec PassKit) :
 *   1. On envoie payload={} + apns-push-type:background + priority:5
 *   2. iOS reçoit le push silencieux → appelle GET /apple/v1/passes/:type/:serial
 *   3. Le serveur régénère le pass avec les nouvelles valeurs de champs
 *   4. Si un champ a un `changeMessage` et que sa valeur a changé,
 *      iOS affiche ce changeMessage comme une bannière de notification visible
 *
 * ⚠️  La notification visible vient du `changeMessage` dans le pass.json,
 *     PAS du payload APNs. Le payload DOIT être {} pour les passes Wallet.
 */
export async function pushApplePassUpdate(pushToken: string, passTypeIdentifier: string): Promise<void> {
  const cert = readSecretFileOrEnv('signer.pem', 'APPLE_SIGNER_CERT_PEM');
  const key = readSecretFileOrEnv('key.pem', 'APPLE_SIGNER_KEY_PEM');
  const endpoint = process.env.APPLE_APNS_ENDPOINT ?? 'https://api.push.apple.com';

  await new Promise<void>((resolvePromise, reject) => {
    const session = connect(endpoint, { cert, key });
    const chunks: Buffer[] = [];
    let status = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      session.close();
      if (error) reject(error);
      else resolvePromise();
    };

    session.on('error', finish);

    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': passTypeIdentifier,
      'apns-priority': '5',
      'apns-push-type': 'background',
    });

    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    request.on('end', () => {
      if (status >= 200 && status < 300) {
        finish();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      finish(new Error(`APNs Wallet update failed (${status}) ${body}`));
    });
    request.on('error', finish);
    request.end('{}');
  });
}
