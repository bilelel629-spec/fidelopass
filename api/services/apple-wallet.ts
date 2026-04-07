import { PKPass } from 'passkit-generator';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { generateStripImage } from './strip-generator';

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
  commerces: {
    nom: string;
    logo_url: string | null;
    latitude: number | null;
    longitude: number | null;
    rayon_geo: number;
  };
}

interface ClientData {
  id: string;
  nom: string | null;
  points_actuels: number;
  tampons_actuels: number;
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
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

const BARCODE_FORMAT_MAP: Record<string, string> = {
  QR: 'PKBarcodeFormatQR',
  PDF417: 'PKBarcodeFormatPDF417',
  AZTEC: 'PKBarcodeFormatAztec',
  CODE128: 'PKBarcodeFormatCode128',
};

export async function generateApplePass(carte: CarteData, client: ClientData): Promise<Buffer> {
  const barcodeType = carte.barcode_type ?? 'QR';
  const labelClient = carte.label_client ?? 'Client';

  const soldeLabel = carte.type === 'tampons' ? 'Tampons' : 'Points';
  const soldeValue = carte.type === 'tampons'
    ? `${client.tampons_actuels}/${carte.tampons_total}`
    : String(client.points_actuels);

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
    logoText: carte.commerces.nom,
    authenticationToken: client.id,
    storeCard: {
      // headerFields : coin supérieur droit (solde)
      headerFields: [
        { key: 'solde', label: soldeLabel.toUpperCase(), value: soldeValue },
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
      // auxiliaryFields : ligne suivante
      auxiliaryFields: [
        {
          key: 'recompense',
          label: 'Récompense',
          value: carte.recompense_description ?? '—',
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
      ],
    },
  };

  const webServiceURL = getAppleWebServiceUrl();
  if (webServiceURL) {
    passJson.webServiceURL = webServiceURL;
  }

  // Code-barres
  if (barcodeType !== 'NONE') {
    const format = BARCODE_FORMAT_MAP[barcodeType] ?? 'PKBarcodeFormatQR';
    passJson.barcode = { message: client.id, format, messageEncoding: 'iso-8859-1' };
    passJson.barcodes = [{ message: client.id, format, messageEncoding: 'iso-8859-1' }];
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
  });

  // ── Logo ──────────────────────────────────────────────────────────
  const logoUrl = carte.logo_url ?? carte.commerces.logo_url;
  const logoRaw = logoUrl ? await fetchImageBuffer(logoUrl) : null;
  const logo1x = logoRaw ? await resizeTo(logoRaw, 120, 120) : readAsset('logo.png');
  const logo2x = logoRaw ? await resizeTo(logoRaw, 240, 240) : readAsset('logo@2x.png');

  // ── Dossier temporaire .pass ──────────────────────────────────────
  const tmpPassDir = resolve(tmpdir(), `fidelopass-${randomUUID()}.pass`);
  mkdirSync(tmpPassDir, { recursive: true });

  try {
    writeFileSync(resolve(tmpPassDir, 'pass.json'), JSON.stringify(passJson));

    writeFileSync(resolve(tmpPassDir, 'icon.png'), readAsset('icon.png'));
    writeFileSync(resolve(tmpPassDir, 'icon@2x.png'), readAsset('icon@2x.png'));
    writeFileSync(resolve(tmpPassDir, 'icon@3x.png'), readAsset('icon@3x.png'));

    writeFileSync(resolve(tmpPassDir, 'logo.png'), logo1x);
    writeFileSync(resolve(tmpPassDir, 'logo@2x.png'), logo2x);

    // strip.png = image générée dynamiquement (tampons ou bannière)
    const strip1x = await sharp(stripBuffer).resize(375, 123, { fit: 'cover' }).png().toBuffer();
    writeFileSync(resolve(tmpPassDir, 'strip.png'), strip1x);
    writeFileSync(resolve(tmpPassDir, 'strip@2x.png'), stripBuffer);

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
