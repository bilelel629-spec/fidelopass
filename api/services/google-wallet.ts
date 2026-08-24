import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createSign } from 'crypto';
import { getPointRewardState } from './point-rewards';

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
  rewards_multi_enabled?: boolean | null;
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
  return normalized === 'pro'
    || normalized.startsWith('pro-')
    || normalized.includes('pro')
    || normalized === 'business'
    || normalized.startsWith('business-')
    || normalized.includes('business');
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

function getRewardsText(carte: CarteData, client?: ClientData): string | null {
  if (carte.type === 'points' && carte.rewards_multi_enabled === true && client) {
    return getPointRewardState(client.points_actuels, carte).reward_catalog
      .map((reward) => reward.disponible
        ? `✓ ${reward.seuil} points : ${reward.recompense} — disponible`
        : `${reward.seuil} points : ${reward.recompense} — encore ${reward.points_manquants} points`)
      .join('\n');
  }
  const rewards = (carte.rewards_multi_enabled === true ? carte.rewards_config ?? [] : [])
    .filter((reward) => reward?.seuil && reward?.recompense)
    .map((reward) => `${reward.seuil} ${carte.type === 'tampons' ? 'tampons' : 'points'} : ${reward.recompense}`);

  return rewards.length ? rewards.join('\n') : null;
}

function getRewardSummary(carte: CarteData, client: ClientData): string {
  if (carte.type !== 'points' || carte.rewards_multi_enabled !== true) {
    return carte.recompense_description ?? '—';
  }
  const state = getPointRewardState(client.points_actuels, carte);
  if (state.available_rewards.length) {
    return `Disponible : ${state.available_rewards.map((reward) => reward.recompense).join(', ')}`;
  }
  return state.next_reward
    ? `${state.next_reward.recompense} — encore ${state.next_reward.points_manquants} points`
    : '—';
}

function getAvailableRewardCount(carte: CarteData, client: ClientData): number {
  if (carte.type === 'points' && carte.rewards_multi_enabled === true) {
    return getPointRewardState(client.points_actuels, carte).available_rewards.length;
  }
  return client.recompenses_obtenues ?? 0;
}

function getVipText(carte: CarteData): string | null {
  const tiers = (carte.vip_tiers ?? [])
    .filter((tier) => tier?.nom && tier?.seuil)
    .map((tier) => `${tier.nom} : ${tier.seuil} points${tier.avantage ? ` — ${tier.avantage}` : ''}`);

  return tiers.length ? tiers.join('\n') : null;
}

function getMerchantLocations(carte: CarteData): Array<{ latitude: number; longitude: number }> | undefined {
  const latitude = Number(carte.commerces.latitude);
  const longitude = Number(carte.commerces.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }

  return [{ latitude, longitude }];
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signGoogleWalletJwt(
  claims: Record<string, unknown>,
  privateKey: string,
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

type HttpRequester = {
  request: (opts: { url: string; method: string; data?: unknown }) => Promise<unknown>;
};

type GoogleAuthConstructor = new (opts: {
  credentials: { client_email: string; private_key: string };
  scopes: string[];
}) => {
  getClient: () => Promise<HttpRequester>;
};

let googleAuthConstructorPromise: Promise<GoogleAuthConstructor> | null = null;

async function getGoogleAuthConstructor(): Promise<GoogleAuthConstructor> {
  if (!googleAuthConstructorPromise) {
    // googleapis embarque un très gros graphe de types. Le charger à la demande
    // évite que les builds/typechecks serveur restent bloqués à analyser tout le SDK.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<{ google: { auth: { GoogleAuth: GoogleAuthConstructor } } }>;
    googleAuthConstructorPromise = dynamicImport('googleapis').then(
      (module) => module.google.auth.GoogleAuth,
    );
  }
  return googleAuthConstructorPromise;
}

// Cache de l'authClient pour éviter un échange OAuth2 à chaque appel
let cachedAuthClient: HttpRequester | null = null;
let cachedAuthClientExpiry = 0;
const AUTH_CLIENT_TTL_MS = 55 * 60 * 1000;

async function getAuthClient(): Promise<HttpRequester> {
  const now = Date.now();
  if (cachedAuthClient && now < cachedAuthClientExpiry) return cachedAuthClient;
  const credentials = getCredentials();
  const GoogleAuth = await getGoogleAuthConstructor();
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
  cachedAuthClient = await auth.getClient();
  cachedAuthClientExpiry = now + AUTH_CLIENT_TTL_MS;
  return cachedAuthClient;
}

export async function upsertLoyaltyClass(carte: CarteData): Promise<string> {
  const issuerId = getIssuerId();
  const classId = `${issuerId}.carte_${carte.id}`;
  const authClient = await getAuthClient();

  const logoUri = carte.logo_url ?? carte.commerces.logo_url
    ?? `${process.env.SUPABASE_URL}/storage/v1/object/public/assets/logo-default.png`;

  // Nom affiché = nom de la CARTE choisie (pas le commerce), pour distinguer
  // les différentes cartes d'un même commerce (plan Pro = jusqu'à 3 cartes).
  const displayName = String(carte.nom ?? '').trim() || String(carte.commerces.nom ?? '').trim() || 'Fidelopass';

  const classData: Record<string, unknown> = {
    id: classId,
    issuerName: displayName,
    programName: displayName,
    programLogo: {
      sourceUri: { uri: logoUri },
      contentDescription: {
        defaultValue: { language: 'fr-FR', value: displayName },
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
        body: getRewardSummary(carte, client),
        id: 'recompense',
      },
      ...(getRewardsText(carte, client) ? [{
        header: 'Récompenses',
        body: getRewardsText(carte, client),
        id: 'recompenses_multiples',
      }] : []),
      ...(getVipText(carte) ? [{
        header: 'Paliers VIP',
        body: getVipText(carte),
        id: 'paliers_vip',
      }] : []),
      {
        header: 'Récompenses dispo',
        body: String(getAvailableRewardCount(carte, client)),
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
      value: String(client.wallet_code ?? client.id).trim() || client.id,
    };
  }

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { loyaltyObjects: [loyaltyObject] },
  };

  const token = signGoogleWalletJwt(claims, credentials.private_key);
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
  // Propage logo/couleur/nom dans la classe en arrière-plan — ne bloque pas le PATCH score.
  upsertLoyaltyClass(carte).catch((err) =>
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
          body: getRewardSummary(carte, client),
          id: 'recompense',
        },
        ...(getRewardsText(carte, client) ? [{
          header: 'Récompenses',
          body: getRewardsText(carte, client),
          id: 'recompenses_multiples',
        }] : []),
        ...(getVipText(carte) ? [{
          header: 'Paliers VIP',
          body: getVipText(carte),
          id: 'paliers_vip',
        }] : []),
        {
          header: 'Récompenses obtenues',
          body: String(getAvailableRewardCount(carte, client)),
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

  try {
    const response = await withTimeout(requester.request({
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
    const status = (response as { status?: number } | undefined)?.status;
    console.info(`[google-wallet addMessage] OK objet=${objectId} status=${status ?? '?'}`);
  } catch (err) {
    const e = err as { code?: number; status?: number; response?: { status?: number; data?: unknown }; message?: string };
    const status = e?.code ?? e?.status ?? e?.response?.status;
    const body = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : e?.message;
    console.error(`[google-wallet addMessage] ÉCHEC objet=${objectId} status=${status ?? '?'} détail=${body}`);
    throw err;
  }
}
