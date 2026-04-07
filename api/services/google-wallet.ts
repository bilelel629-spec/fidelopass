import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import jwt from 'jsonwebtoken';

interface CarteData {
  id: string;
  nom: string;
  type: 'points' | 'tampons';
  tampons_total: number;
  points_recompense: number;
  recompense_description: string | null;
  couleur_fond: string;
  logo_url?: string | null;
  strip_url?: string | null;
  barcode_type?: string | null;
  label_client?: string | null;
  commerces: {
    nom: string;
    logo_url: string | null;
  };
}

interface ClientData {
  id: string;
  nom: string | null;
  points_actuels: number;
  tampons_actuels: number;
}

const GOOGLE_WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

function getCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
      client_email: string;
      private_key: string;
    };
  }

  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    ?? resolve(process.cwd(), 'certs/google-service-account.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as {
    client_email: string;
    private_key: string;
  };
}

function getIssuerId(): string {
  const id = process.env.GOOGLE_ISSUER_ID;
  if (!id) throw new Error('GOOGLE_ISSUER_ID non configuré');
  return id;
}

async function getAuthClient() {
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
  return auth.getClient();
}

async function upsertLoyaltyClass(carte: CarteData): Promise<string> {
  const issuerId = getIssuerId();
  const classId = `${issuerId}.carte_${carte.id}`;
  const authClient = await getAuthClient();

  const logoUri = carte.logo_url ?? carte.commerces.logo_url
    ?? `${process.env.SUPABASE_URL}/storage/v1/object/public/assets/logo-default.png`;

  const classData: Record<string, unknown> = {
    id: classId,
    issuerName: carte.commerces.nom,
    programName: carte.nom,
    programLogo: {
      sourceUri: { uri: logoUri },
      contentDescription: {
        defaultValue: { language: 'fr-FR', value: carte.commerces.nom },
      },
    },
    hexBackgroundColor: carte.couleur_fond,
    reviewStatus: 'UNDER_REVIEW',
  };

  // Image bannière (hero image)
  if (carte.strip_url) {
    classData.heroImage = {
      sourceUri: { uri: carte.strip_url },
      contentDescription: { defaultValue: { language: 'fr-FR', value: carte.nom } },
    };
  }

  const requester = authClient as unknown as {
    request: (opts: { url: string; method: string; data?: unknown }) => Promise<unknown>;
  };

  try {
    await requester.request({
      url: `${GOOGLE_WALLET_API}/loyaltyClass/${classId}`,
      method: 'PUT',
      data: classData,
    });
  } catch {
    await requester.request({
      url: `${GOOGLE_WALLET_API}/loyaltyClass`,
      method: 'POST',
      data: classData,
    });
  }

  return classId;
}

export async function generateGooglePass(
  carte: CarteData,
  client: ClientData,
): Promise<{ objectId: string; saveUrl: string }> {
  const issuerId = getIssuerId();
  const credentials = getCredentials();
  const classId = await upsertLoyaltyClass(carte);
  const objectId = `${issuerId}.client_${client.id}`;

  const solde = carte.type === 'tampons'
    ? `${client.tampons_actuels}/${carte.tampons_total}`
    : String(client.points_actuels);

  const GOOGLE_BARCODE_MAP: Record<string, string> = {
    QR: 'QR_CODE', PDF417: 'PDF_417', AZTEC: 'AZTEC', CODE128: 'CODE_128',
  };
  const barcodeType = carte.barcode_type ?? 'QR';

  const loyaltyObject: Record<string, unknown> = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    loyaltyPoints: {
      label: (carte.label_client ?? 'Points').toUpperCase(),
      balance: { string: solde },
    },
    textModulesData: [
      {
        header: 'Récompense',
        body: carte.recompense_description ?? '—',
        id: 'recompense',
      },
    ],
  };

  if (barcodeType !== 'NONE') {
    loyaltyObject.barcode = {
      type: GOOGLE_BARCODE_MAP[barcodeType] ?? 'QR_CODE',
      value: client.id,
    };
  }

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { loyaltyObjects: [loyaltyObject] },
  };

  const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
  return {
    objectId,
    saveUrl: `https://pay.google.com/gp/v/save/${token}`,
  };
}
