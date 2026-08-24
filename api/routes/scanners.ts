import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { sendGoogleWalletMessage, updateGooglePassObject } from '../services/google-wallet';
import { buildBillingStatusPayload, type BillingRecord } from '../services/billing';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';
import {
  applyProgressIncrement,
  applyRewardRedemption,
  applyScoreReset,
  getProgramType,
  usesMultiplePointRewards,
} from '../services/loyalty-progress';
import { getPointRewardState, resolvePointRewardRedemption } from '../services/point-rewards';

export const scannersRoutes = new Hono<ApiEnv>();

const SCANNER_TOKEN_HEADER = 'x-scanner-token';
const INSTALL_TOKEN_TTL_SECONDS = 15 * 60;

const registerScannerSchema = z.object({
  scanner_token: z.string().min(16).max(160),
  device_name: z.string().max(120).optional().nullable(),
});

const claimScannerSchema = registerScannerSchema.extend({
  claim_token: z.string().min(24).max(2400),
});

const scannerTransactionSchema = z.object({
  client_id: z.string().uuid(),
  type: z.enum(['ajout_points', 'ajout_tampon', 'recompense', 'reset']),
  valeur: z.number().int().min(1).max(10000),
  reward_threshold: z.number().int().min(1).max(100000).optional(),
});

const CLIENT_SELECT = `
  *,
  cartes(
    id,
    nom,
    type,
    tampons_total,
    points_recompense,
    recompense_description,
    couleur_fond,
    logo_url,
    strip_url,
    barcode_type,
    label_client,
    rewards_multi_enabled,
    rewards_config,
    vip_tiers,
    branding_powered_by_enabled,
    commerces(nom, logo_url, plan)
  )
`;

type ScannerDevice = {
  id: string;
  commerce_id: string;
  point_vente_id: string;
  scanner_token: string;
  device_name?: string | null;
};

type ScannerContext = {
  db: ReturnType<typeof createServiceClient>;
  scanner: ScannerDevice;
  commerce: BillingRecord & { nom?: string | null; actif?: boolean | null; plan_override?: string | null };
  pointVente: { id: string; nom: string | null; actif: boolean | null };
};

type ScanClient = {
  id: string;
  nom: string | null;
  telephone: string | null;
  email?: string | null;
  wallet_code?: string | null;
  commerce_id: string;
  point_vente_id: string | null;
  points_actuels: number;
  tampons_actuels: number;
  recompenses_obtenues: number;
  google_pass_id?: string | null;
  apple_pass_serial?: string | null;
  fcm_token?: string | null;
  push_enabled?: boolean | null;
  cartes: {
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
      plan?: string | null;
    };
    [key: string]: unknown;
  };
};

type InstallTokenPayload = {
  commerce_id: string;
  point_vente_id: string;
  exp: number;
  nonce: string;
};

function base64url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function scannerSigningSecret() {
  const secret = process.env.SCANNER_INSTALL_SECRET
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.JWT_SECRET
    ?? '';
  if (!secret) {
    throw new Error('SCANNER_INSTALL_SECRET, SUPABASE_SERVICE_ROLE_KEY ou JWT_SECRET est requis');
  }
  return secret;
}

function signScannerPayload(payloadPart: string) {
  return base64url(createHmac('sha256', scannerSigningSecret()).update(payloadPart).digest());
}

function createInstallToken(payload: Omit<InstallTokenPayload, 'exp' | 'nonce'>) {
  const fullPayload: InstallTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + INSTALL_TOKEN_TTL_SECONDS,
    nonce: randomBytes(12).toString('hex'),
  };
  const payloadPart = base64url(JSON.stringify(fullPayload));
  return `${payloadPart}.${signScannerPayload(payloadPart)}`;
}

function verifyInstallToken(token: string): InstallTokenPayload | null {
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart) return null;

  const expected = signScannerPayload(payloadPart);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64url(payloadPart)) as InstallTokenPayload;
    if (!payload.commerce_id || !payload.point_vente_id || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicSiteUrl(c: Context) {
  const envUrl = process.env.PUBLIC_SITE_URL ?? process.env.SITE_URL ?? '';
  const origin = c.req.header('origin') ?? 'https://www.fidelopass.com';
  return (envUrl || origin).replace(/\/$/, '');
}

async function loadCommerceForUser(userId: string, requestedPointVenteId: string | null) {
  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, nom, plan',
  );
  return { db, commerce, pointVente };
}

async function loadOrderedScannerTokens(db: ReturnType<typeof createServiceClient>, commerceId: string, pointVenteId: string) {
  const { data } = await db
    .from('scanner_devices')
    .select('scanner_token')
    .eq('commerce_id', commerceId)
    .eq('point_vente_id', pointVenteId)
    .order('created_at', { ascending: true });
  return (data ?? []).map((row) => row.scanner_token).filter(Boolean) as string[];
}

function readScannerToken(c: Context) {
  const headerToken = c.req.header(SCANNER_TOKEN_HEADER);
  const bearer = c.req.header('authorization')?.startsWith('Scanner ')
    ? c.req.header('authorization')?.slice('Scanner '.length)
    : null;
  const queryToken = c.req.query('scanner_token');
  return (headerToken ?? bearer ?? queryToken ?? '').trim();
}

async function loadScannerContext(c: Context): Promise<ScannerContext | Response> {
  const scannerToken = readScannerToken(c);
  if (!scannerToken || scannerToken.length < 16) {
    return c.json({ success: false, code: 'SCANNER_NOT_LINKED', error: 'Ce téléphone n’est pas encore associé au commerce.' }, 401);
  }

  const db = createServiceClient();
  const { data: scanner, error: scannerError } = await db
    .from('scanner_devices')
    .select('id, commerce_id, point_vente_id, scanner_token, device_name')
    .eq('scanner_token', scannerToken)
    .maybeSingle();

  if (scannerError) {
    return c.json({ success: false, code: 'SCANNER_LOOKUP_FAILED', error: 'Impossible de vérifier ce téléphone scanner.' }, 500);
  }
  if (!scanner) {
    return c.json({ success: false, code: 'SCANNER_NOT_LINKED', error: 'Ce téléphone n’est pas encore associé au commerce.' }, 401);
  }

  const [commerceResult, pointResult] = await Promise.all([
    db
      .from('commerces')
      .select(`
        id,
        nom,
        plan,
        billing_status,
        stripe_subscription_id,
        stripe_customer_id,
        stripe_price_id,
        trial_ends_at,
        billing_interval,
        billing_commitment,
        billing_current_period_end,
        billing_cancel_at_period_end,
        billing_cancel_at,
        billing_canceled_at,
        billing_access_ends_at,
        onboarding_completed,
        actif
      `)
      .eq('id', scanner.commerce_id)
      .maybeSingle(),
    db
      .from('points_vente')
      .select('id, nom, actif')
      .eq('id', scanner.point_vente_id)
      .maybeSingle(),
  ]);

  if (commerceResult.error || !commerceResult.data) {
    return c.json({ success: false, code: 'COMMERCE_NOT_FOUND', error: 'Commerce introuvable pour ce scanner.' }, 404);
  }
  if (pointResult.error || !pointResult.data || pointResult.data.actif === false) {
    return c.json({ success: false, code: 'POINT_DE_VENTE_INACTIVE', error: 'Le point de vente associé à ce scanner est inactif.' }, 403);
  }

  const commerce = commerceResult.data as ScannerContext['commerce'];
  if (commerce.actif === false) {
    return c.json({ success: false, code: 'COMMERCE_INACTIVE', error: 'Ce commerce est inactif.' }, 403);
  }

  const billing = buildBillingStatusPayload(commerce);
  if (!billing.has_access) {
    return c.json({ success: false, code: 'SUBSCRIPTION_REQUIRED', error: 'Abonnement requis pour utiliser le scanner.' }, 402);
  }

  await db
    .from('scanner_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', scanner.id);

  return {
    db,
    scanner: scanner as ScannerDevice,
    commerce,
    pointVente: pointResult.data as ScannerContext['pointVente'],
  };
}

function normalizeScanCode(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

function extractScanCode(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  const uuidMatch = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (uuidMatch?.[0]) return uuidMatch[0];

  const fidMatch = raw.match(/FID-[A-Z0-9]{4,16}/i);
  if (fidMatch?.[0]) return normalizeScanCode(fidMatch[0]);

  try {
    const url = new URL(raw);
    const explicitCode = url.searchParams.get('code') ?? url.searchParams.get('wallet_code') ?? url.searchParams.get('client');
    if (explicitCode) return normalizeScanCode(explicitCode);
  } catch {
    // Ce n'est pas une URL, on garde le texte brut.
  }

  return normalizeScanCode(raw);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function findClientByCode(db: ReturnType<typeof createServiceClient>, code: string) {
  const column = isUuid(code) ? 'id' : 'wallet_code';
  const { data, error } = await db
    .from('clients')
    .select(CLIENT_SELECT)
    .eq(column, code)
    .maybeSingle();

  if (error) throw error;
  return data as unknown as ScanClient | null;
}

async function loadClientById(db: ReturnType<typeof createServiceClient>, clientId: string) {
  const { data, error } = await db
    .from('clients')
    .select(CLIENT_SELECT)
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as ScanClient | null;
}

async function loadRecentHistory(db: ReturnType<typeof createServiceClient>, clientId: string) {
  const { data } = await db
    .from('transactions')
    .select('id, type, valeur, points_avant, points_apres, note, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(6);

  return data ?? [];
}

function getProgress(client: ScanClient) {
  const carte = client.cartes;
  if (carte.type === 'points') {
    const rewardState = getPointRewardState(client.points_actuels, carte);
    return {
      current: client.points_actuels ?? 0,
      goal: rewardState.next_reward?.seuil
        ?? rewardState.reward_catalog.at(-1)?.seuil
        ?? carte.points_recompense
        ?? 10,
      label: 'points',
      addType: 'ajout_points' as const,
    };
  }

  return {
    current: client.tampons_actuels ?? 0,
    goal: carte.tampons_total ?? 10,
    label: 'tampons',
    addType: 'ajout_tampon' as const,
  };
}

async function formatScanResponse(db: ReturnType<typeof createServiceClient>, client: ScanClient) {
  const progress = getProgress(client);
  const history = await loadRecentHistory(db, client.id);
  const rewardsAvailable = client.recompenses_obtenues ?? 0;
  const pointRewardState = client.cartes.type === 'points'
    ? getPointRewardState(client.points_actuels, client.cartes)
    : null;

  return {
    client: {
      id: client.id,
      wallet_code: client.wallet_code ?? client.id,
      nom: client.nom ?? 'Client anonyme',
      telephone: client.telephone ?? null,
      email: client.email ?? null,
      points_actuels: client.points_actuels ?? 0,
      tampons_actuels: client.tampons_actuels ?? 0,
      recompenses_obtenues: rewardsAvailable,
    },
    carte: {
      id: client.cartes.id,
      nom: client.cartes.nom,
      type: client.cartes.type,
      reward_description: client.cartes.recompense_description ?? 'Récompense',
      rewards_multi_enabled: client.cartes.rewards_multi_enabled === true,
    },
    progress,
    reward_state: pointRewardState,
    can_use_reward: usesMultiplePointRewards(client.cartes)
      ? pointRewardState?.can_use_reward === true
      : rewardsAvailable > 0,
    history,
  };
}

function scannerScopeError(c: Context, client: ScanClient | null, scanner: ScannerDevice) {
  if (!client) return c.json({ success: false, code: 'CLIENT_NOT_FOUND', error: 'Carte client introuvable.' }, 404);
  if (client.commerce_id !== scanner.commerce_id) {
    return c.json({ success: false, code: 'WRONG_COMMERCE', error: 'Cette carte appartient à un autre commerce.' }, 403);
  }
  if (client.point_vente_id && client.point_vente_id !== scanner.point_vente_id) {
    return c.json({ success: false, code: 'WRONG_POINT_DE_VENTE', error: 'Cette carte appartient à un autre point de vente.' }, 403);
  }
  return null;
}

function applyClientStateGuard<T extends { eq: (column: string, value: unknown) => T }>(
  query: T,
  client: ScanClient,
): T {
  return query
    .eq('points_actuels', client.points_actuels ?? 0)
    .eq('tampons_actuels', client.tampons_actuels ?? 0)
    .eq('recompenses_obtenues', client.recompenses_obtenues ?? 0);
}

async function updateWalletsAfterScannerTransaction(
  db: ReturnType<typeof createServiceClient>,
  client: ScanClient,
  updatedClient: ScanClient,
  walletMessage?: { titre: string; body: string },
) {
  const walletUpdates: Array<Promise<{ provider: string; ok: boolean; count?: number; error?: string }>> = [];

  if (client.google_pass_id) {
    walletUpdates.push(
      updateGooglePassObject(
        client.google_pass_id,
        client.cartes as Parameters<typeof updateGooglePassObject>[1],
        updatedClient,
      )
        .then(() => ({ provider: 'google', ok: true }))
        .catch((error) => {
          console.error('[scanner google update]', error);
          return { provider: 'google', ok: false, error: error instanceof Error ? error.message : 'Google update failed' };
        }),
    );

    // Notification visible Google Wallet (addMessage TEXT_AND_NOTIFY)
    if (walletMessage) {
      walletUpdates.push(
        sendGoogleWalletMessage(client.google_pass_id, walletMessage.titre, walletMessage.body)
          .then(() => ({ provider: 'google_message', ok: true }))
          .catch((error) => {
            console.error('[scanner google message]', error);
            return { provider: 'google_message', ok: false, error: error instanceof Error ? error.message : 'Google message failed' };
          }),
      );
    }
  }

  if (client.apple_pass_serial) {
    walletUpdates.push((async () => {
      const { data, error } = await db
        .from('apple_pass_registrations')
        .select('push_token, pass_type_identifier')
        .eq('client_id', client.id);

      if (error) {
        console.error('[scanner apple registrations]', error);
        return { provider: 'apple', ok: false, count: 0, error: error.message };
      }

      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((data ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      const results = await Promise.allSettled(
        uniqueRegistrations.map((registration) =>
          pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
        ),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) console.error('[scanner apple push]', failed.reason);
      return { provider: 'apple', ok: !failed, count: uniqueRegistrations.length };
    })());
  }

  return Promise.all(walletUpdates);
}

/** POST /api/scanners/install-token — génère un lien d'association depuis l'espace commerçant */
scannersRoutes.post('/install-token', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await loadCommerceForUser(userId, requestedPointVenteId);
  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const claimToken = createInstallToken({
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
  });
  const installUrl = `${publicSiteUrl(c)}/app/install?claim=${encodeURIComponent(claimToken)}`;
  return c.json({
    data: {
      claim_token: claimToken,
      install_url: installUrl,
      expires_in: INSTALL_TOKEN_TTL_SECONDS,
      point_vente_id: pointVente.id,
      point_vente_nom: pointVente.nom,
    },
  });
});

/** GET /api/scanners/status — statut depuis l'espace commerçant connecté */
scannersRoutes.get('/status', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const scannerToken = c.req.query('scanner_token')?.trim() ?? null;
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { db, commerce, pointVente } = await loadCommerceForUser(userId, requestedPointVenteId);
  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const effectivePlan = getEffectivePlanRaw(commerce);
  const tokens = await loadOrderedScannerTokens(db, commerce.id, pointVente.id);
  const currentCount = tokens.length;

  let registeredForToken = false;
  if (scannerToken) {
    registeredForToken = tokens.includes(scannerToken);
    if (registeredForToken) {
      await db
        .from('scanner_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('commerce_id', commerce.id)
        .eq('point_vente_id', pointVente.id)
        .eq('scanner_token', scannerToken);
    }
  }

  return c.json({
    data: {
      plan: effectivePlan,
      raw_plan: commerce.plan ?? 'starter',
      plan_override: commerce.plan_override ?? null,
      max_scanners: null,
      current_scanners: currentCount,
      total_scanners: tokens.length,
      remaining_scanners: null,
      registered_for_token: registeredForToken,
      overflow_scanners: 0,
      unlimited_scanners: true,
      point_vente_id: pointVente.id,
    },
  });
});

/** POST /api/scanners/register — compat connecté, conservé pour les anciens liens */
scannersRoutes.post('/register', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const parsed = registerScannerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const { scanner_token: scannerToken, device_name: deviceName } = parsed.data;
  const { db, commerce, pointVente } = await loadCommerceForUser(userId, requestedPointVenteId);
  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: existing } = await db
    .from('scanner_devices')
    .select('id')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('scanner_token', scannerToken)
    .maybeSingle();

  if (existing) {
    await db.from('scanner_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    const { error: insertError } = await db.from('scanner_devices').insert({
      commerce_id: commerce.id,
      point_vente_id: pointVente.id,
      scanner_token: scannerToken,
      device_name: deviceName ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      last_seen_at: new Date().toISOString(),
    });
    if (insertError) return c.json({ error: 'Impossible d’enregistrer ce scanner pour le moment.' }, 500);
  }

  const nextTokens = await loadOrderedScannerTokens(db, commerce.id, pointVente.id);
  return c.json({
    data: {
      already_registered: Boolean(existing),
      max_scanners: null,
      current_scanners: nextTokens.length,
      total_scanners: nextTokens.length,
      remaining_scanners: null,
      unlimited_scanners: true,
    },
  }, existing ? 200 : 201);
});

/** POST /api/scanners/claim — associe un téléphone sans session commerçant complète */
scannersRoutes.post('/claim', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = claimScannerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, code: 'INVALID_CLAIM', error: 'Lien d’installation invalide.' }, 400);
  }

  const claim = verifyInstallToken(parsed.data.claim_token);
  if (!claim) {
    return c.json({ success: false, code: 'INVALID_OR_EXPIRED_CLAIM', error: 'Lien d’installation expiré. Regénérez un QR depuis le dashboard.' }, 401);
  }

  const db = createServiceClient();
  const [commerceResult, pointResult] = await Promise.all([
    db.from('commerces').select('id, actif').eq('id', claim.commerce_id).maybeSingle(),
    db.from('points_vente').select('id, commerce_id, actif').eq('id', claim.point_vente_id).maybeSingle(),
  ]);
  if (commerceResult.error || !commerceResult.data || commerceResult.data.actif === false) {
    return c.json({ success: false, code: 'COMMERCE_NOT_FOUND', error: 'Commerce introuvable pour ce lien scanner.' }, 404);
  }
  if (pointResult.error || !pointResult.data || pointResult.data.actif === false || pointResult.data.commerce_id !== claim.commerce_id) {
    return c.json({ success: false, code: 'POINT_DE_VENTE_NOT_FOUND', error: 'Point de vente introuvable pour ce lien scanner.' }, 404);
  }

  const { scanner_token: scannerToken, device_name: deviceName } = parsed.data;
  const { data: existing } = await db
    .from('scanner_devices')
    .select('id')
    .eq('commerce_id', claim.commerce_id)
    .eq('point_vente_id', claim.point_vente_id)
    .eq('scanner_token', scannerToken)
    .maybeSingle();

  if (existing) {
    await db.from('scanner_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    const { error } = await db.from('scanner_devices').insert({
      commerce_id: claim.commerce_id,
      point_vente_id: claim.point_vente_id,
      scanner_token: scannerToken,
      device_name: deviceName ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      last_seen_at: new Date().toISOString(),
    });
    if (error) {
      return c.json({ success: false, code: 'SCANNER_REGISTER_FAILED', error: 'Impossible d’associer ce téléphone pour le moment.' }, 500);
    }
  }

  return c.json({ success: true, data: { registered: true, point_vente_id: claim.point_vente_id } }, existing ? 200 : 201);
});

/** GET /api/scanners/me — état du téléphone scanner associé */
scannersRoutes.get('/me', async (c) => {
  const scannerContext = await loadScannerContext(c);
  if (scannerContext instanceof Response) return scannerContext;

  return c.json({
    success: true,
    data: {
      commerce_id: scannerContext.commerce.id,
      commerce_nom: scannerContext.commerce.nom ?? 'Commerce',
      point_vente_id: scannerContext.pointVente.id,
      point_vente_nom: scannerContext.pointVente.nom ?? 'Point de vente',
    },
  });
});

/** GET /api/scanners/scan — lecture client via token scanner */
scannersRoutes.get('/scan', async (c) => {
  const scannerContext = await loadScannerContext(c);
  if (scannerContext instanceof Response) return scannerContext;

  const code = extractScanCode(c.req.query('code'));
  if (!code) return c.json({ success: false, code: 'EMPTY_SCAN', error: 'Scan vide, veuillez réessayer.' }, 400);

  const client = await findClientByCode(scannerContext.db, code);
  const scopeError = scannerScopeError(c, client, scannerContext.scanner);
  if (scopeError) return scopeError;

  return c.json({ success: true, data: await formatScanResponse(scannerContext.db, client as ScanClient) });
});

/** POST /api/scanners/transactions — ajout points/tampons/récompense via token scanner */
scannersRoutes.post('/transactions', async (c) => {
  const scannerContext = await loadScannerContext(c);
  if (scannerContext instanceof Response) return scannerContext;

  const body = await c.req.json().catch(() => null);
  const parsed = scannerTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, code: 'INVALID_TRANSACTION', error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const client = await loadClientById(scannerContext.db, parsed.data.client_id);
  const scopeError = scannerScopeError(c, client, scannerContext.scanner);
  if (scopeError) return scopeError;
  const safeClient = client as ScanClient;

  const currentProgress = getProgress(safeClient);
  let progressResult = {
    newPoints: safeClient.points_actuels ?? 0,
    newTampons: safeClient.tampons_actuels ?? 0,
    recompensesObtenues: safeClient.recompenses_obtenues ?? 0,
    activeScoreBefore: currentProgress.current,
    activeScoreAfter: currentProgress.current,
    rewardsEarned: 0,
  };
  let transactionValue = parsed.data.valeur;
  let transactionNote = 'Scan caisse mobile';

  switch (parsed.data.type) {
    case 'ajout_points':
      if (getProgramType(safeClient.cartes) !== 'points') {
        return c.json({ success: false, code: 'WRONG_PROGRAM_TYPE', error: 'Cette carte utilise des tampons, pas des points.' }, 400);
      }
      progressResult = applyProgressIncrement(safeClient.cartes, safeClient, parsed.data.valeur);
      break;
    case 'ajout_tampon':
      if (getProgramType(safeClient.cartes) !== 'tampons') {
        return c.json({ success: false, code: 'WRONG_PROGRAM_TYPE', error: 'Cette carte utilise des points, pas des tampons.' }, 400);
      }
      progressResult = applyProgressIncrement(safeClient.cartes, safeClient, parsed.data.valeur);
      break;
    case 'recompense':
      if (usesMultiplePointRewards(safeClient.cartes)) {
        const redemption = resolvePointRewardRedemption(
          safeClient.points_actuels,
          safeClient.cartes,
          parsed.data.reward_threshold,
        );
        if (!redemption.ok) {
          const errors = {
            NO_REWARD_AVAILABLE: 'Le client n’a pas encore assez de points pour utiliser une récompense.',
            REWARD_SELECTION_REQUIRED: 'Choisissez la récompense à attribuer.',
            REWARD_NOT_FOUND: 'Cette récompense n’existe plus dans le programme.',
            INSUFFICIENT_POINTS: 'Le client n’a pas assez de points pour cette récompense.',
          } as const;
          return c.json({ success: false, code: redemption.reason, error: errors[redemption.reason] }, 409);
        }
        progressResult = {
          newPoints: redemption.points_after,
          newTampons: safeClient.tampons_actuels,
          recompensesObtenues: safeClient.recompenses_obtenues,
          activeScoreBefore: redemption.points_before,
          activeScoreAfter: redemption.points_after,
          rewardsEarned: 0,
        };
        transactionValue = redemption.reward.seuil;
        transactionNote = `Récompense utilisée via scan caisse : ${redemption.reward.recompense}`;
        break;
      }
      if ((safeClient.recompenses_obtenues ?? 0) <= 0) {
        return c.json({ success: false, code: 'NO_REWARD_AVAILABLE', error: 'Le client n’a pas de récompense disponible.' }, 409);
      }
      progressResult = applyRewardRedemption(safeClient.cartes, safeClient, parsed.data.valeur);
      break;
    case 'reset':
      progressResult = applyScoreReset(safeClient.cartes, safeClient);
      break;
  }

  const nextPoints = progressResult.newPoints;
  const nextTampons = progressResult.newTampons;
  const nextRewards = progressResult.recompensesObtenues;

  const updatedAt = new Date().toISOString();
  const updateQuery = scannerContext.db.from('clients').update({
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      derniere_visite: updatedAt,
      updated_at: updatedAt,
    })
    .eq('id', safeClient.id)
    .eq('commerce_id', scannerContext.scanner.commerce_id);

  const updateResult = await applyClientStateGuard(updateQuery, safeClient).select('id').maybeSingle();
  if (updateResult.error) {
    return c.json({ success: false, code: 'CLIENT_UPDATE_FAILED', error: 'Erreur serveur, veuillez réessayer.' }, 500);
  }
  if (!updateResult.data) {
    return c.json({ success: false, code: 'CLIENT_ALREADY_UPDATED', error: 'La fiche client vient déjà d’être modifiée. Scannez à nouveau pour voir le solde à jour.' }, 409);
  }

  const transactionResult = await scannerContext.db.from('transactions').insert({
    client_id: safeClient.id,
    commerce_id: scannerContext.scanner.commerce_id,
    point_vente_id: scannerContext.scanner.point_vente_id,
    type: parsed.data.type,
    valeur: transactionValue,
    points_avant: progressResult.activeScoreBefore,
    points_apres: progressResult.activeScoreAfter,
    note: transactionNote,
  }).select().single();

  if (transactionResult.error) {
    return c.json({ success: false, code: 'TRANSACTION_INSERT_FAILED', error: 'Passage ajouté, mais historique non enregistré. Rechargez la fiche client.' }, 202);
  }

  const updatedClient = {
    ...safeClient,
    points_actuels: nextPoints,
    tampons_actuels: nextTampons,
    recompenses_obtenues: nextRewards,
  };

  // Message de notification wallet personnalisé selon l'opération
  const carteFull = safeClient.cartes as { type?: string; tampons_total?: number; points_recompense?: number };
  const isPoints = carteFull.type === 'points';
  const newScore = isPoints ? nextPoints : nextTampons;
  const rewardThreshold = isPoints ? (carteFull.points_recompense || 100) : (carteFull.tampons_total || 10);
  const remainingToReward = Math.max(0, rewardThreshold - newScore);
  const rewardJustEarned = nextRewards > (safeClient.recompenses_obtenues ?? 0);
  let walletMessage: { titre: string; body: string } | undefined;
  if (parsed.data.type === 'recompense') {
    walletMessage = { titre: '✅ Récompense utilisée', body: 'Merci de votre fidélité !' };
  } else if (parsed.data.type === 'reset') {
    walletMessage = undefined;
  } else if (rewardJustEarned) {
    walletMessage = { titre: '🎁 Récompense débloquée !', body: 'Présentez votre carte pour en profiter.' };
  } else {
    walletMessage = {
      titre: isPoints ? '🎉 Points ajoutés !' : '🎉 Nouveau tampon !',
      body: remainingToReward > 0
        ? `Plus que ${remainingToReward} avant votre récompense.`
        : 'Votre récompense est à portée !',
    };
  }

  const wallet_update_results = await updateWalletsAfterScannerTransaction(scannerContext.db, safeClient, updatedClient, walletMessage);

  return c.json({
    success: true,
    data: transactionResult.data,
    client: {
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      ...(safeClient.cartes.type === 'points'
        ? { reward_state: getPointRewardState(nextPoints, safeClient.cartes) }
        : {}),
    },
    wallet_update_results,
  }, 201);
});
