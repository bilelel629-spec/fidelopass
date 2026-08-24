import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { sendGoogleWalletMessage, updateGooglePassObject } from '../services/google-wallet';
import { applyProgressIncrement, applyRewardRedemption, usesMultiplePointRewards } from '../services/loyalty-progress';
import { getPointRewardState, resolvePointRewardRedemption } from '../services/point-rewards';
import { sendPersonalizedPushNotifications } from '../services/push';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getPublicSiteUrl } from '../utils/public-site-url';

export const merchantScanRoutes = new Hono();

merchantScanRoutes.use('*', authMiddleware);
merchantScanRoutes.use('*', paidMiddleware);

const MAX_SCAN_INPUT_LENGTH = 1000;
const MAX_SCAN_CODE_LENGTH = 200;

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
      latitude?: number | null;
      longitude?: number | null;
      rayon_geo?: number | null;
      plan?: string | null;
    };
    [key: string]: unknown;
  };
};

function normalizeScanCode(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

function extractScanCode(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_SCAN_INPUT_LENGTH) return '';

  const uuidMatch = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  if (uuidMatch?.[0]) return uuidMatch[0];

  const fidMatch = raw.match(/FID-[A-Z0-9]{4,16}/i);
  if (fidMatch?.[0]) return normalizeScanCode(fidMatch[0]);

  try {
    const url = new URL(raw);
    const explicitCode = url.searchParams.get('code')
      ?? url.searchParams.get('wallet_code')
      ?? url.searchParams.get('client')
      ?? url.searchParams.get('client_id');
    if (explicitCode) return normalizeScanCode(explicitCode);
  } catch {
    // Ce n'est pas une URL, on garde le texte brut.
  }

  return normalizeScanCode(raw);
}

function isSafeScanCode(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SCAN_CODE_LENGTH;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

async function loadRecentHistory(db: ReturnType<typeof createServiceClient>, clientId: string) {
  const { data } = await db
    .from('transactions')
    .select('id, type, valeur, points_avant, points_apres, note, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(6);

  return data ?? [];
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

// Push Apple Wallet — priorité absolue, déclenché en premier et isolé de Google
// pour que l'APNs ne soit jamais retardé par la charge Google Wallet.
async function pushAppleAfterScan(
  db: ReturnType<typeof createServiceClient>,
  client: ScanClient,
) {
  if (!client.apple_pass_serial) return;
  try {
    const { data, error } = await db
      .from('apple_pass_registrations')
      .select('push_token, pass_type_identifier')
      .eq('client_id', client.id);

    if (error) {
      console.error('[merchant-scan apple registrations]', error);
      return;
    }

    const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
    const uniqueRegistrations = Array.from(
      new Map((data ?? []).map((registration) => [registration.push_token, registration])).values(),
    );

    await Promise.allSettled(
      uniqueRegistrations.map((registration) =>
        pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
      ),
    );
  } catch (e) {
    console.error('[merchant-scan apple push]', e instanceof Error ? e.message : e);
  }
}

async function updateWalletsAfterScan(
  db: ReturnType<typeof createServiceClient>,
  client: ScanClient,
  updatedClient: ScanClient,
  walletMessage?: { titre: string; body: string },
) {
  // 1) Apple d'abord, seul, sans rien d'autre en concurrence (push quasi instantané)
  void pushAppleAfterScan(db, client);

  // 2) Google ensuite, en arrière-plan (non bloquant, non prioritaire)
  if (client.google_pass_id) {
    void updateGooglePassObject(
      client.google_pass_id,
      client.cartes as Parameters<typeof updateGooglePassObject>[1],
      updatedClient,
    ).catch((error) => console.error('[merchant-scan google update]', error));

    if (walletMessage) {
      void sendGoogleWalletMessage(client.google_pass_id, walletMessage.titre, walletMessage.body)
        .catch((error) => console.error('[merchant-scan google message]', error));
    }
  }
}

async function sendWebPushAfterScan(
  db: ReturnType<typeof createServiceClient>,
  clientId: string,
  carteLogoUrl: string | null | undefined,
  title: string,
  body: string,
) {
  try {
    const { data: subscriptions } = await db
      .from('web_push_subscriptions')
      .select('endpoint, p256dh, auth, carte_id, client_id')
      .eq('client_id', clientId)
      .eq('enabled', true);

    if (!subscriptions?.length) return;

    const siteUrl = getPublicSiteUrl();
    const recipients = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      clickUrl: `${siteUrl}/carte/${sub.carte_id}/web?client=${sub.client_id}`,
    }));

    await sendPersonalizedPushNotifications(
      recipients,
      title,
      body,
      carteLogoUrl ?? undefined,
    );
  } catch (error) {
    console.warn('[merchant-scan web-push]', error instanceof Error ? error.message : error);
  }
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

async function assertClientScope(
  c: Context,
  client: ScanClient | null,
  commerceId: string,
  pointVenteId: string,
) {
  if (!client) return c.json({ success: false, error: 'Aucun client trouvé pour ce code.' }, 404);
  if (client.commerce_id !== commerceId) {
    return c.json({ success: false, error: 'Ce pass n’appartient pas à ce commerce.' }, 403);
  }
  if ((client.point_vente_id ?? '') !== pointVenteId) {
    return c.json({ success: false, error: 'Ce pass appartient à un autre point de vente.' }, 403);
  }
  return null;
}

merchantScanRoutes.get('/scan', async (c) => {
  const userId = c.get('userId') as string;
  const code = extractScanCode(c.req.query('code'));

  if (!code) return c.json({ success: false, error: 'Scan vide, veuillez réessayer.' }, 400);
  if (!isSafeScanCode(code)) {
    return c.json({ success: false, error: 'Code scanné trop long ou invalide.' }, 400);
  }

  if (code === 'FID-DEMO123') {
    return c.json({
      success: true,
      data: {
        demo: true,
        client: {
          id: 'demo',
          wallet_code: 'FID-DEMO123',
          nom: 'Client démo',
          telephone: '06 00 00 00 00',
          email: null,
          points_actuels: 4,
          tampons_actuels: 4,
          recompenses_obtenues: 0,
        },
        carte: { id: 'demo', nom: 'Carte démo', type: 'tampons', reward_description: '1 café offert' },
        progress: { current: 4, goal: 10, label: 'tampons', addType: 'ajout_tampon' },
        can_use_reward: false,
        history: [],
      },
    });
  }

  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');

  if (!commerce || !pointVente) return c.json({ success: false, error: 'Commerce introuvable.' }, 404);

  const client = await findClientByCode(db, code);
  const scopeError = await assertClientScope(c, client, commerce.id, pointVente.id);
  if (scopeError) return scopeError;

  return c.json({ success: true, data: await formatScanResponse(db, client as ScanClient) });
});

async function handleAddPoint(c: Context) {
  const userId = c.get('userId') as string;
  const clientId = c.req.param('id');
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');

  if (!commerce || !pointVente) return c.json({ success: false, error: 'Commerce introuvable.' }, 404);

  const { data, error } = await db.from('clients').select(CLIENT_SELECT).eq('id', clientId).maybeSingle();
  if (error) throw error;
  const client = data as unknown as ScanClient | null;
  const scopeError = await assertClientScope(c, client, commerce.id, pointVente.id);
  if (scopeError) return scopeError;

  const safeClient = client as ScanClient;
  const progress = getProgress(safeClient);
  const progressResult = applyProgressIncrement(safeClient.cartes, safeClient, 1);
  const nextPoints = progressResult.newPoints;
  const nextTampons = progressResult.newTampons;
  const nextRewards = progressResult.recompensesObtenues;

  const updatedAt = new Date().toISOString();
  const updateQuery = db.from('clients').update({
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      derniere_visite: updatedAt,
      updated_at: updatedAt,
    })
    .eq('id', safeClient.id)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id);

  const updateResult = await applyClientStateGuard(updateQuery, safeClient).select('id').maybeSingle();

  if (updateResult.error) {
    return c.json({ success: false, error: 'Erreur serveur, veuillez réessayer.' }, 500);
  }

  if (!updateResult.data) {
    return c.json({
      success: false,
      error: 'La fiche client vient déjà d’être modifiée. Scannez à nouveau pour voir le solde à jour.',
    }, 409);
  }

  const transactionResult = await db.from('transactions').insert({
    client_id: safeClient.id,
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
    type: progress.addType,
    valeur: 1,
    points_avant: progressResult.activeScoreBefore,
    points_apres: progressResult.activeScoreAfter,
    note: 'Scan caisse scannette',
  });

  if (transactionResult.error) {
    return c.json({ success: false, error: 'Passage ajouté, mais historique non enregistré. Rechargez la fiche client.' }, 202);
  }

  const updatedClient = {
    ...safeClient,
    points_actuels: nextPoints,
    tampons_actuels: nextTampons,
    recompenses_obtenues: nextRewards,
  };
  const carteData = safeClient.cartes as { id: string; type?: string; nom?: string; logo_url?: string | null; tampons_total?: number; points_recompense?: number };
  const isPoints = carteData.type === 'points';
  const scoreValue = isPoints ? updatedClient.points_actuels : updatedClient.tampons_actuels;
  const threshold = isPoints ? (carteData.points_recompense || 100) : (carteData.tampons_total || 10);
  const remaining = Math.max(0, threshold - scoreValue);
  const rewardsAvail = updatedClient.recompenses_obtenues ?? 0;
  const scanMessage = rewardsAvail > 0
    ? {
        titre: '🎁 Récompense débloquée !',
        body: 'Présentez votre carte pour en profiter.',
      }
    : {
        titre: isPoints ? '🎉 Points ajoutés !' : '🎉 Nouveau tampon !',
        body: remaining > 0
          ? `Plus que ${remaining} avant votre récompense.`
          : 'Votre récompense est à portée !',
      };

  void updateWalletsAfterScan(db, safeClient, updatedClient, scanMessage);
  void sendWebPushAfterScan(db, safeClient.id, carteData.logo_url, scanMessage.titre, scanMessage.body);

  return c.json({
    success: true,
    message: safeClient.cartes.type === 'points' ? '+1 point ajouté.' : '+1 tampon ajouté.',
    data: await formatScanResponse(db, updatedClient),
  });
}

async function handleUseReward(c: Context) {
  const userId = c.get('userId') as string;
  const clientId = c.req.param('id');
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');

  if (!commerce || !pointVente) return c.json({ success: false, error: 'Commerce introuvable.' }, 404);

  const { data, error } = await db.from('clients').select(CLIENT_SELECT).eq('id', clientId).maybeSingle();
  if (error) throw error;
  const client = data as unknown as ScanClient | null;
  const scopeError = await assertClientScope(c, client, commerce.id, pointVente.id);
  if (scopeError) return scopeError;

  const safeClient = client as ScanClient;
  const body = await c.req.json().catch(() => ({}));
  const bodyResult = z.object({
    reward_threshold: z.number().int().min(1).max(100000).optional(),
  }).safeParse(body);
  if (!bodyResult.success) return c.json({ success: false, error: 'Récompense invalide.' }, 400);

  let selectedPointReward: { seuil: number; recompense: string } | null = null;
  let progressResult;
  if (usesMultiplePointRewards(safeClient.cartes)) {
    const redemption = resolvePointRewardRedemption(
      safeClient.points_actuels,
      safeClient.cartes,
      bodyResult.data.reward_threshold,
    );
    if (!redemption.ok) {
      const errors = {
        NO_REWARD_AVAILABLE: 'Le client n’a pas encore assez de points pour utiliser une récompense.',
        REWARD_SELECTION_REQUIRED: 'Choisissez la récompense à attribuer.',
        REWARD_NOT_FOUND: 'Cette récompense n’existe plus dans le programme.',
        INSUFFICIENT_POINTS: 'Le client n’a pas assez de points pour cette récompense.',
      } as const;
      return c.json({ success: false, error: errors[redemption.reason] }, 409);
    }
    selectedPointReward = redemption.reward;
    progressResult = {
      newPoints: redemption.points_after,
      newTampons: safeClient.tampons_actuels,
      recompensesObtenues: safeClient.recompenses_obtenues,
      activeScoreBefore: redemption.points_before,
      activeScoreAfter: redemption.points_after,
      rewardsEarned: 0,
    };
  } else {
    if ((safeClient.recompenses_obtenues ?? 0) <= 0) {
      return c.json({
        success: false,
        error: 'Le client n’a pas encore assez de points pour utiliser une récompense.',
      }, 409);
    }
    progressResult = applyRewardRedemption(safeClient.cartes, safeClient, 1);
  }
  const nextRewards = progressResult.recompensesObtenues;
  const nextPoints = progressResult.newPoints;
  const nextTampons = progressResult.newTampons;
  const updatedAt = new Date().toISOString();

  const updateQuery = db.from('clients').update({
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      derniere_visite: updatedAt,
      updated_at: updatedAt,
    })
    .eq('id', safeClient.id)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id);

  const updateResult = await applyClientStateGuard(updateQuery, safeClient).select('id').maybeSingle();

  if (updateResult.error) {
    return c.json({ success: false, error: 'Erreur serveur, veuillez réessayer.' }, 500);
  }

  if (!updateResult.data) {
    return c.json({
      success: false,
      error: 'La fiche client vient déjà d’être modifiée. Scannez à nouveau pour voir le solde à jour.',
    }, 409);
  }

  const transactionResult = await db.from('transactions').insert({
    client_id: safeClient.id,
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
    type: 'recompense',
    valeur: selectedPointReward?.seuil ?? 1,
    points_avant: progressResult.activeScoreBefore,
    points_apres: progressResult.activeScoreAfter,
    note: selectedPointReward
      ? `Récompense utilisée via scan caisse : ${selectedPointReward.recompense}`
      : 'Récompense utilisée via scan caisse scannette',
  });

  if (transactionResult.error) {
    return c.json({ success: false, error: 'Récompense utilisée, mais historique non enregistré. Rechargez la fiche client.' }, 202);
  }

  const updatedClient = {
    ...safeClient,
    points_actuels: nextPoints,
    tampons_actuels: nextTampons,
    recompenses_obtenues: nextRewards,
  };
  const carteDataReward = safeClient.cartes as { id: string; type?: string; nom?: string; logo_url?: string | null };
  const rewardMessage = {
    titre: '✅ Récompense utilisée',
    body: 'Merci de votre fidélité !',
  };

  void updateWalletsAfterScan(db, safeClient, updatedClient, rewardMessage);
  void sendWebPushAfterScan(db, safeClient.id, carteDataReward.logo_url, rewardMessage.titre, rewardMessage.body);

  return c.json({
    success: true,
    message: selectedPointReward
      ? `${selectedPointReward.recompense} utilisée. Il reste ${nextPoints} point(s).`
      : 'Récompense utilisée avec succès.',
    data: await formatScanResponse(db, updatedClient),
  });
}

merchantScanRoutes.post('/customers/:id/add-point', handleAddPoint);
merchantScanRoutes.post('/customers/:id/use-reward', handleUseReward);
