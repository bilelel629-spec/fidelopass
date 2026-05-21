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
  rewards_config?: Array<{ seuil: number; recompense: string }> | null;
  vip_tiers?: Array<{ nom: string; seuil: number; avantage?: string }> | null;
  branding_powered_by_enabled?: boolean | null;
  commerces: {
    nom: string;
    logo_url: string | null;
    latitude?: number | null;
    longitude?: number | null;
    rayon_geo?: number | null;
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

function isProPlan(plan: string | null | undefined): boolean {
  const normalized = String(plan ?? 'starter').trim().toLowerCase();
  return normalized === 'pro' || normalized.startsWith('pro-') || normalized.includes('pro');
}

const GOOGLE_WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const GOOGLE_WALLET_TIMEOUT_MS = 15_000;
const GOOGLE_WALLET_FAST_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Google Wallet API timeout (${ms}ms)`)), ms),
    ),
  ]);
}

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

function getRewardsText(carte: CarteData): string | null {
  const rewards = (carte.rewards_config ?? [])
    .filter((reward) => reward?.seuil && reward?.recompense)
    .map((reward) => `${reward.seuil} ${carte.type === 'tampons' ? 'tampons' : 'points'} : ${reward.recompense}`);

  return rewards.length ? rewards.join('\n') : null;
}

function getVipText(carte: CarteData): string | null {
  const tiers = (carte.vip_tiers ?? [])
    .filter((tier) => tier?.nom && tier?.seuil)
    .map((tier) => `${tier.nom} : ${tier.seuil} points${tier.avantage ? ` — ${tier.avantage}` : ''}`);

  return tiers.length ? tiers.join('\n') : null;
}

function getMerchantLocations(carte: CarteData): Array<{ latitude: number; longitude: number }> | undefined {
  const latitude = carte.commerces.latitude;
  const longitude = carte.commerces.longitude;

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return undefined;
  }

  return [{ latitude, longitude }];
}

// Cache de l'authClient pour éviter un échange OAuth2 à chaque appel
type GAuthClient = Awaited<ReturnType<InstanceType<typeof google.auth.GoogleAuth>['getClient']>>;
let cachedAuthClient: GAuthClient | null = null;
let cachedAuthClientExpiry = 0;
const AUTH_CLIENT_TTL_MS = 55 * 60 * 1000;

async function getAuthClient(): Promise<GAuthClient> {
  const now = Date.now();
  if (cachedAuthClient && now < cachedAuthClientExpiry) return cachedAuthClient;
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
  cachedAuthClient = await auth.getClient();
  cachedAuthClientExpiry = now + AUTH_CLIENT_TTL_MS;
  return cachedAuthClient;
}

type HttpRequester = {
  request: (opts: { url: string; method: string; data?: unknown }) => Promise<unknown>;
};

export async function upsertLoyaltyClass(carte: CarteData): Promise<string> {
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

  const merchantLocations = getMerchantLocations(carte);
  if (merchantLocations) {
    classData.merchantLocations = merchantLocations;
  }

  if (carte.strip_url) {
    classData.heroImage = {
      sourceUri: { uri: carte.strip_url },
      contentDescription: { defaultValue: { language: 'fr-FR', value: carte.nom } },
    };
  }

  const requester = authClient as unknown as HttpRequester;

  // PUT (upsert). Si 404 → POST (création initiale). Tout autre code est propagé.
  try {
    await withTimeout(requester.request({
      url: `${GOOGLE_WALLET_API}/loyaltyClass/${classId}`,
      method: 'PUT',
      data: classData,
    }), GOOGLE_WALLET_TIMEOUT_MS);
  } catch (err: unknown) {
    const status = (err as { code?: number; status?: number })?.code
      ?? (err as { code?: number; status?: number })?.status;
    if (status === 404 || status === 409) {
      try {
        await withTimeout(requester.request({
          url: `${GOOGLE_WALLET_API}/loyaltyClass`,
          method: 'POST',
          data: classData,
        }), GOOGLE_WALLET_TIMEOUT_MS);
      } catch (createErr: unknown) {
        const createStatus = (createErr as { code?: number; status?: number })?.code
          ?? (createErr as { code?: number; status?: number })?.status;
        if (createStatus !== 409) throw createErr;
      }
    } else {
      throw err;
    }
  }

  return classId;
}

export async function generateGooglePass(
  carte: CarteData,
  client: ClientData,
  walletMessage?: WalletMessage | null,
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
  const barcodeType = carte.barcode_type ?? 'CODE128';

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
      ...(getRewardsText(carte) ? [{
        header: 'Récompenses',
        body: getRewardsText(carte),
        id: 'recompenses_multiples',
      }] : []),
      ...(getVipText(carte) ? [{
        header: 'Paliers VIP',
        body: getVipText(carte),
        id: 'paliers_vip',
      }] : []),
      {
        header: 'Récompenses dispo',
        body: String(client.recompenses_obtenues ?? 0),
        id: 'recompenses_disponibles',
      },
      ...((isProPlan(carte.commerces.plan) && carte.branding_powered_by_enabled === false)
        ? []
        : [{
          header: 'Signature',
          body: 'Propulsé par Fidelopass',
          id: 'branding_fidelopass',
        }]),
      ...(walletMessage?.message ? [{
        header: walletMessage.titre || 'Message',
        body: walletMessage.message,
        id: 'message_wallet',
      }] : []),
    ],
  };

  const merchantLocations = getMerchantLocations(carte);
  if (merchantLocations) {
    loyaltyObject.merchantLocations = merchantLocations;
  }

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

export async function updateGooglePassObject(
  objectId: string,
  carte: CarteData,
  client: ClientData,
): Promise<void> {
  // Propage les changements de logo/couleur/nom dans la classe aussi
  await upsertLoyaltyClass(carte).catch((err) =>
    console.error('[Google Wallet] upsertLoyaltyClass échec lors de la mise à jour:', err),
  );

  const authClient = await getAuthClient();
  const solde = carte.type === 'tampons'
    ? `${client.tampons_actuels}/${carte.tampons_total}`
    : String(client.points_actuels);

  const requester = authClient as unknown as HttpRequester;

  await withTimeout(requester.request({
    url: `${GOOGLE_WALLET_API}/loyaltyObject/${objectId}`,
    method: 'PATCH',
    data: {
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
        ...(getRewardsText(carte) ? [{
          header: 'Récompenses',
          body: getRewardsText(carte),
          id: 'recompenses_multiples',
        }] : []),
        ...(getVipText(carte) ? [{
          header: 'Paliers VIP',
          body: getVipText(carte),
          id: 'paliers_vip',
        }] : []),
        {
          header: 'Récompenses obtenues',
          body: String(client.recompenses_obtenues ?? 0),
          id: 'recompenses_disponibles',
        },
        ...((isProPlan(carte.commerces.plan) && carte.branding_powered_by_enabled === false)
          ? []
          : [{
            header: 'Signature',
            body: 'Propulsé par Fidelopass',
            id: 'branding_fidelopass',
          }]),
      ],
      ...(getMerchantLocations(carte) ? { merchantLocations: getMerchantLocations(carte) } : {}),
    },
  }), GOOGLE_WALLET_FAST_TIMEOUT_MS);
}

export async function sendGoogleWalletMessage(
  objectId: string,
  titre: string,
  message: string,
  notificationId?: string,
): Promise<void> {
  const authClient = await getAuthClient();
  const requester = authClient as unknown as HttpRequester;

  await withTimeout(requester.request({
    url: `${GOOGLE_WALLET_API}/loyaltyObject/${objectId}/addMessage`,
    method: 'POST',
    data: {
      message: {
        id: notificationId ? `notif_${notificationId}` : `notif_${Date.now()}`,
        header: titre,
        body: message,
        messageType: 'TEXT_AND_NOTIFY',
      },
    },
  }), GOOGLE_WALLET_FAST_TIMEOUT_MS);
}
