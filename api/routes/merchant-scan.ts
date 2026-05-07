import { Hono } from 'hono';
import type { Context } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { updateGooglePassObject } from '../services/google-wallet';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';

export const merchantScanRoutes = new Hono();

merchantScanRoutes.use('*', authMiddleware);
merchantScanRoutes.use('*', paidMiddleware);

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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getProgress(client: ScanClient) {
  const carte = client.cartes;
  if (carte.type === 'points') {
    return {
      current: client.points_actuels ?? 0,
      goal: carte.points_recompense ?? 10,
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
    },
    progress,
    can_use_reward: rewardsAvailable > 0,
    history,
  };
}

async function updateWalletsAfterScan(
  db: ReturnType<typeof createServiceClient>,
  client: ScanClient,
  updatedClient: ScanClient,
) {
  const walletUpdates: Array<Promise<unknown>> = [];

  if (client.google_pass_id) {
    walletUpdates.push(
      updateGooglePassObject(
        client.google_pass_id,
        client.cartes as Parameters<typeof updateGooglePassObject>[1],
        updatedClient,
      ).catch((error) => console.error('[merchant-scan google update]', error)),
    );
  }

  if (client.apple_pass_serial) {
    walletUpdates.push((async () => {
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
    })());
  }

  await Promise.allSettled(walletUpdates);
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
  const code = normalizeScanCode(c.req.query('code'));

  if (!code) return c.json({ success: false, error: 'Scan vide, veuillez réessayer.' }, 400);

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
  const before = progress.current;
  let nextPoints = safeClient.points_actuels ?? 0;
  let nextTampons = safeClient.tampons_actuels ?? 0;
  let nextRewards = safeClient.recompenses_obtenues ?? 0;

  if (safeClient.cartes.type === 'points') {
    nextPoints += 1;
    if (before < progress.goal && nextPoints >= progress.goal) {
      nextRewards += 1;
      nextPoints = progress.goal;
    }
  } else {
    nextTampons += 1;
    if (before < progress.goal && nextTampons >= progress.goal) {
      nextRewards += 1;
      nextTampons = progress.goal;
    }
  }

  const updatedAt = new Date().toISOString();
  const [updateResult, transactionResult] = await Promise.all([
    db.from('clients').update({
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      derniere_visite: updatedAt,
      updated_at: updatedAt,
    }).eq('id', safeClient.id),
    db.from('transactions').insert({
      client_id: safeClient.id,
      commerce_id: commerce.id,
      point_vente_id: pointVente.id,
      type: progress.addType,
      valeur: 1,
      points_avant: before,
      points_apres: safeClient.cartes.type === 'points' ? nextPoints : nextTampons,
      note: 'Scan caisse scannette',
    }),
  ]);

  if (updateResult.error || transactionResult.error) {
    return c.json({ success: false, error: 'Erreur serveur, veuillez réessayer.' }, 500);
  }

  const updatedClient = {
    ...safeClient,
    points_actuels: nextPoints,
    tampons_actuels: nextTampons,
    recompenses_obtenues: nextRewards,
  };
  await updateWalletsAfterScan(db, safeClient, updatedClient);

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
  if ((safeClient.recompenses_obtenues ?? 0) <= 0) {
    return c.json({
      success: false,
      error: 'Le client n’a pas encore assez de points pour utiliser une récompense.',
    }, 409);
  }

  const progress = getProgress(safeClient);
  const nextRewards = Math.max(0, (safeClient.recompenses_obtenues ?? 0) - 1);
  const nextPoints = safeClient.cartes.type === 'points' ? 0 : safeClient.points_actuels;
  const nextTampons = safeClient.cartes.type === 'tampons' ? 0 : safeClient.tampons_actuels;
  const updatedAt = new Date().toISOString();

  const [updateResult, transactionResult] = await Promise.all([
    db.from('clients').update({
      points_actuels: nextPoints,
      tampons_actuels: nextTampons,
      recompenses_obtenues: nextRewards,
      derniere_visite: updatedAt,
      updated_at: updatedAt,
    }).eq('id', safeClient.id),
    db.from('transactions').insert({
      client_id: safeClient.id,
      commerce_id: commerce.id,
      point_vente_id: pointVente.id,
      type: 'recompense',
      valeur: 1,
      points_avant: progress.current,
      points_apres: 0,
      note: 'Récompense utilisée via scan caisse scannette',
    }),
  ]);

  if (updateResult.error || transactionResult.error) {
    return c.json({ success: false, error: 'Erreur serveur, veuillez réessayer.' }, 500);
  }

  const updatedClient = {
    ...safeClient,
    points_actuels: nextPoints,
    tampons_actuels: nextTampons,
    recompenses_obtenues: nextRewards,
  };
  await updateWalletsAfterScan(db, safeClient, updatedClient);

  return c.json({
    success: true,
    message: 'Récompense utilisée avec succès.',
    data: await formatScanResponse(db, updatedClient),
  });
}

merchantScanRoutes.post('/customers/:id/add-point', handleAddPoint);
merchantScanRoutes.post('/customers/:id/use-reward', handleUseReward);
