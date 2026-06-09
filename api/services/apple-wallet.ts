import { PKPass } from 'passkit-generator';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { normalize, resolve } from 'path';
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
  tampon_icon_scale?: number | null;
  barcode_type?: string | null;
  label_client?: string | null;
  couleur_fond_2?: string | null;
  gradient_angle?: number | null;
  pattern_type?: string | null;
  tampon_emoji?: string | null;
  strip_layout?: string | null;
  banner_overlay_opacity?: number | null;
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
  wallet_code?: string | null;
  nom: string | null;
  points_actuels: number;
  tampons_actuels: number;
  recompenses_obtenues?: number;
}

interface WalletMessage {
  titre: string;
  message: string;
}

// ── Cache d'assets image ────────────────────────────────────────────────────
// Le logo, le fond et les icônes ne dépendent QUE du design de la carte (pas du
// score). La strip dépend du design + du nombre de tampons. On les met en cache
// pour qu'une mise à jour de solde ne re-télécharge plus le logo ni ne régénère
// les images via Sharp → régénération de pass quasi instantanée (~50 ms vs ~1 s).
type DesignAssets = {
  logo1x: Buffer; logo2x: Buffer;
  icon1x: Buffer; icon2x: Buffer; icon3x: Buffer;
  bg1x: Buffer; bg2x: Buffer; bg3x: Buffer;
};
type StripAssets = { strip1x: Buffer; strip2x: Buffer };

const designAssetCache = new Map<string, DesignAssets>();
const stripAssetCache = new Map<string, StripAssets>();
const MAX_CACHE_ENTRIES = 400;

function cacheSet<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function isProPlan(plan: string | null | undefined): boolean {
  const normalized = String(plan ?? 'starter').trim().toLowerCase();
  return normalized === 'pro'
    || normalized.startsWith('pro-')
    || normalized.includes('pro')
    || normalized === 'business'
    || normalized.startsWith('business-')
    || normalized.includes('business');
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

const PUBLIC_DIR = resolve(process.cwd(), 'public');

function getPublicAppUrl(): string {
  return (process.env.APP_URL ?? process.env.PUBLIC_APP_URL ?? 'https://www.fidelopass.com').replace(/\/+$/, '');
}

function normalizePublicAssetPath(value: string): string | null {
  const pathOnly = value.split('?')[0]?.split('#')[0] ?? '';
  if (!pathOnly.startsWith('/') || pathOnly.includes('\0')) return null;
  const normalized = normalize(pathOnly).replace(/^[/\\]+/, '');
  if (!normalized || normalized.startsWith('..')) return null;
  return normalized;
}

function readPublicAssetBuffer(value: string): Buffer | null {
  const relativePath = normalizePublicAssetPath(value);
  if (!relativePath) return null;
  const filePath = resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) return null;

  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
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
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    const localAsset = readPublicAssetBuffer(trimmed);
    if (localAsset) return localAsset;
    return fetchImageBuffer(`${getPublicAppUrl()}${trimmed}`);
  }

  try {
    const res = await fetch(trimmed, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

async function resizeTo(buf: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'centre' }).png().toBuffer();
}

async function createPassIcon(buf: Buffer, size: number, backgroundHex: string): Promise<Buffer> {
  // Keep a generous margin so notification background color remains clearly visible.
  const padding = Math.max(4, Math.round(size * 0.2));
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

function getWalletScanCode(client: ClientData): string {
  return String(client.wallet_code ?? client.id).trim() || client.id;
}

export async function generateApplePass(
  carte: CarteData,
  client: ClientData,
  walletMessage?: WalletMessage | null,
): Promise<Buffer> {
  const barcodeType = carte.barcode_type ?? 'CODE128';
  const barcodeValue = getWalletScanCode(client);
  const labelClient = carte.label_client ?? 'Client';

  const soldeLabel = carte.type === 'tampons' ? 'Tampons' : 'Points';
  const soldeValue = carte.type === 'tampons'
    ? `${client.tampons_actuels}/${carte.tampons_total}`
    : String(client.points_actuels);

  // Message de notification personnalisé selon la progression du client.
  // Affiché par iOS dès que le solde change (= à chaque tampon/point/récompense).
  const isTampons = carte.type === 'tampons';
  const currentScore = isTampons ? (client.tampons_actuels ?? 0) : (client.points_actuels ?? 0);
  const rewardThreshold = isTampons ? (carte.tampons_total || 10) : (carte.points_recompense || 100);
  const remainingToReward = Math.max(0, rewardThreshold - currentScore);
  const rewardsAvailable = client.recompenses_obtenues ?? 0;
  const soldeChangeMessage = rewardsAvailable > 0
    ? '🎁 Récompense débloquée ! Présentez votre carte pour en profiter.'
    : isTampons
      ? (remainingToReward > 0
          ? `🎉 Nouveau tampon ! Plus que ${remainingToReward} avant votre récompense.`
          : '🎉 Nouveau tampon ! Votre récompense est à portée.')
      : (remainingToReward > 0
          ? `🎉 Points ajoutés ! Plus que ${remainingToReward} avant votre récompense.`
          : '🎉 Points ajoutés ! Votre récompense est à portée.');
  const rewardsText = (carte.rewards_config ?? [])
    .filter((reward) => reward?.seuil && reward?.recompense)
    .map((reward) => `${reward.seuil} ${carte.type === 'tampons' ? 'tampons' : 'points'} : ${reward.recompense}`)
    .join('\n');
  const vipText = (carte.vip_tiers ?? [])
    .filter((tier) => tier?.nom && tier?.seuil)
    .map((tier) => `${tier.nom} : ${tier.seuil} points${tier.avantage ? ` — ${tier.avantage}` : ''}`)
    .join('\n');

  const walletDisplayName = String(carte.nom ?? '').trim() || String(carte.commerces.nom ?? '').trim() || 'Fidelopass';

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
    teamIdentifier: process.env.APPLE_TEAM_ID,
    serialNumber: client.id,
    organizationName: walletDisplayName,
    description: carte.nom,
    foregroundColor: hexToRgb(carte.couleur_texte),
    backgroundColor: hexToRgb(carte.couleur_fond),
    labelColor: hexToRgb(carte.couleur_accent),
    logoText: walletDisplayName,
    authenticationToken: (client as { apple_auth_token?: string | null }).apple_auth_token ?? client.id,
    storeCard: {
      // headerFields : coin supérieur droit (solde)
      headerFields: [
        {
          key: 'solde',
          label: soldeLabel.toUpperCase(),
          value: soldeValue,
          changeMessage: soldeChangeMessage,
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
        },
        {
          key: 'recompenses_disponibles',
          label: 'Récompenses dispo',
          value: String(client.recompenses_obtenues ?? 0),
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
      message: barcodeValue,
      format,
      messageEncoding: 'iso-8859-1',
      ...(brandingAltText ? { altText: brandingAltText } : {}),
    };
    passJson.barcodes = [{
      message: barcodeValue,
      format,
      messageEncoding: 'iso-8859-1',
      ...(brandingAltText ? { altText: brandingAltText } : {}),
    }];
  }

  // Géolocalisation
  const latitude = Number(carte.commerces.latitude);
  const longitude = Number(carte.commerces.longitude);
  const maxDistance = Number(carte.commerces.rayon_geo);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    passJson.locations = [{
      latitude,
      longitude,
      relevantText: carte.message_geo || 'Votre carte de fidélité vous attend !',
      ...(Number.isFinite(maxDistance) ? { maxDistance } : {}),
    }];
  }

  const logoUrl = carte.logo_url ?? carte.commerces.logo_url;

  // ── Assets de DESIGN (logo, fond, icônes) — invariants face au score ──────
  // Clé = uniquement les champs qui influencent ces images. Une mise à jour de
  // score ne change pas la clé → on réutilise le cache (pas de fetch logo, pas de Sharp).
  const designKey = JSON.stringify([
    carte.id, logoUrl, carte.push_icon_bg_color, carte.couleur_fond, carte.couleur_accent,
    carte.couleur_fond_2, carte.gradient_angle, carte.pattern_type,
  ]);
  let design = designAssetCache.get(designKey);
  if (!design) {
    const logoRaw = logoUrl ? await fetchImageBuffer(logoUrl) : null;
    const logo1x = logoRaw ? await resizeTo(logoRaw, 120, 120) : readAsset('logo.png');
    const logo2x = logoRaw ? await resizeTo(logoRaw, 240, 240) : readAsset('logo@2x.png');
    // Fond de l'icône de notification : réglage push dédié, sinon fond/accent de la carte.
    const customPushBg = isHexColor(carte.push_icon_bg_color)
      && carte.push_icon_bg_color.toLowerCase() !== '#6366f1'
      ? carte.push_icon_bg_color
      : null;
    const iconBgColor = customPushBg
      ? customPushBg
      : (isHexColor(carte.couleur_fond)
        ? carte.couleur_fond
        : (isHexColor(carte.couleur_accent) ? carte.couleur_accent : '#6366f1'));
    const iconSource = logoRaw ?? readAsset('icon@3x.png');
    const icon1x = await createPassIcon(iconSource, 38, iconBgColor);
    const icon2x = await createPassIcon(iconSource, 76, iconBgColor);
    const icon3x = await createPassIcon(iconSource, 114, iconBgColor);
    const background2x = await generatePassBackgroundImage({
      couleurFond: carte.couleur_fond,
      couleurAccent: carte.couleur_accent,
      couleurFond2: carte.couleur_fond_2,
      gradientAngle: carte.gradient_angle,
      patternType: carte.pattern_type,
      width: 360,
      height: 440,
    });
    const bg1x = await sharp(background2x).resize(180, 220, { fit: 'cover' }).png().toBuffer();
    const bg3x = await sharp(background2x).resize(540, 660, { fit: 'cover' }).png().toBuffer();
    design = { logo1x, logo2x, icon1x, icon2x, icon3x, bg1x, bg2x: background2x, bg3x };
    cacheSet(designAssetCache, designKey, design);
  }

  // ── STRIP (bannière + tampons) — dépend du design ET du nombre de tampons ──
  const stripKey = JSON.stringify([
    carte.id, carte.type, client.tampons_actuels, carte.tampons_total,
    carte.couleur_fond, carte.couleur_accent, carte.strip_url, carte.strip_position,
    carte.tampon_icon_url, carte.tampon_icon_scale, carte.couleur_fond_2,
    carte.gradient_angle, carte.pattern_type, carte.tampon_emoji, carte.strip_layout,
    carte.banner_overlay_opacity,
  ]);
  let strip = stripAssetCache.get(stripKey);
  if (!strip) {
    const stripBuffer = await generateStripImage({
      type: carte.type,
      tamponsActuels: client.tampons_actuels,
      tamponsTotal: carte.tampons_total,
      couleurFond: carte.couleur_fond,
      couleurAccent: carte.couleur_accent,
      stripImageUrl: carte.strip_url,
      stripPosition: carte.strip_position ?? 'center',
      tamponIconUrl: carte.tampon_icon_url,
      tamponIconScale: carte.tampon_icon_scale,
      couleurFond2: carte.couleur_fond_2,
      gradientAngle: carte.gradient_angle,
      patternType: carte.pattern_type,
      tamponEmoji: carte.tampon_emoji,
      stripLayout: carte.strip_layout,
      bannerOverlayOpacity: carte.banner_overlay_opacity,
      showBranding: false,
    });
    const strip1x = await sharp(stripBuffer).resize(375, 123, { fit: 'cover' }).png().toBuffer();
    strip = { strip1x, strip2x: stripBuffer };
    cacheSet(stripAssetCache, stripKey, strip);
  }

  // ── Dossier temporaire .pass ──────────────────────────────────────
  const tmpPassDir = resolve(tmpdir(), `fidelopass-${randomUUID()}.pass`);
  mkdirSync(tmpPassDir, { recursive: true });

  try {
    writeFileSync(resolve(tmpPassDir, 'pass.json'), JSON.stringify(passJson));

    writeFileSync(resolve(tmpPassDir, 'icon.png'), design.icon1x);
    writeFileSync(resolve(tmpPassDir, 'icon@2x.png'), design.icon2x);
    writeFileSync(resolve(tmpPassDir, 'icon@3x.png'), design.icon3x);

    writeFileSync(resolve(tmpPassDir, 'logo.png'), design.logo1x);
    writeFileSync(resolve(tmpPassDir, 'logo@2x.png'), design.logo2x);

    writeFileSync(resolve(tmpPassDir, 'strip.png'), strip.strip1x);
    writeFileSync(resolve(tmpPassDir, 'strip@2x.png'), strip.strip2x);
    writeFileSync(resolve(tmpPassDir, 'background.png'), design.bg1x);
    writeFileSync(resolve(tmpPassDir, 'background@2x.png'), design.bg2x);
    writeFileSync(resolve(tmpPassDir, 'background@3x.png'), design.bg3x);

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
const APNS_TIMEOUT_MS = 10_000;

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
      clearTimeout(timer);
      session.close();
      if (error) reject(error);
      else resolvePromise();
    };

    const timer = setTimeout(() => finish(new Error('APNs push timeout')), APNS_TIMEOUT_MS);

    session.on('error', finish);

    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': passTypeIdentifier,
      'apns-priority': '5',
      'apns-push-type': 'background',
      'content-type': 'application/json',
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
