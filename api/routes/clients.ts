import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { getPlanLimits } from './commerces';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { updateGooglePassObject } from '../services/google-wallet';
import { applyProgressIncrement, usesMultiplePointRewards } from '../services/loyalty-progress';
import { getPointRewardState } from '../services/point-rewards';
import { scheduleSMS, personnaliserMessage } from '../../src/lib/brevo-sms';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');

export const clientsRoutes = new Hono<ApiEnv>();

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

function generateWalletCode() {
  return `FID-${randomBytes(5).toString('hex').slice(0, 8).toUpperCase()}`;
}

/** GET /api/clients/public/:id — État minimal du client pour la page carte publique */
clientsRoutes.get('/public/:id', async (c) => {
  const clientId = c.req.param('id') ?? '';
  const carteId = c.req.query('carte_id');
  const db = createServiceClient();

  if (!carteId) return c.json({ error: 'carte_id requis' }, 400);

  const { data, error } = await db
    .from('clients')
    .select(`
      id,
      nom,
      telephone,
      date_naissance,
      wallet_code,
      push_enabled,
      carte_id,
      points_actuels,
      tampons_actuels,
      recompenses_obtenues,
      cartes(
        id,
        actif,
        type,
        tampons_total,
        points_recompense,
        recompense_description,
        rewards_multi_enabled,
        rewards_config
      )
    `)
    .eq('id', clientId)
    .single();

  if (error || !data) return c.json({ error: 'Client introuvable' }, 404);
  if (data.carte_id !== carteId) return c.json({ error: 'Client introuvable' }, 404);

  const carte = Array.isArray(data.cartes) ? data.cartes[0] : data.cartes;
  if (!carte?.actif) return c.json({ error: 'Carte introuvable' }, 404);

  return c.json({
    data: {
      id: data.id,
      nom: data.nom,
      telephone: data.telephone,
      date_naissance: data.date_naissance,
      wallet_code: data.wallet_code,
      push_enabled: Boolean(data.push_enabled),
      points_actuels: data.points_actuels,
      tampons_actuels: data.tampons_actuels,
      recompenses_obtenues: data.recompenses_obtenues,
      ...(carte.type === 'points'
        ? { reward_state: getPointRewardState(data.points_actuels, carte) }
        : {}),
      carte: {
        id: carte.id,
        type: carte.type,
        tampons_total: carte.tampons_total,
        points_recompense: carte.points_recompense,
        recompense_description: carte.recompense_description,
        rewards_multi_enabled: carte.rewards_multi_enabled === true,
        rewards_config: carte.rewards_config ?? [],
      },
    },
  });
});

/** POST /api/clients/public/:id/web-open — Trace une ouverture de carte web */
clientsRoutes.post('/public/:id/web-open', async (c) => {
  const clientId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ carte_id: z.string().uuid() }).safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, recorded: false, error: 'carte_id requis' }, 400);
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from('clients')
    .select(`
      id,
      carte_id,
      commerce_id,
      point_vente_id,
      cartes(id, actif)
    `)
    .eq('id', clientId)
    .maybeSingle();

  if (error || !data) return c.json({ ok: false, recorded: false, error: 'Client introuvable' }, 404);
  if (data.carte_id !== parsed.data.carte_id) return c.json({ ok: false, recorded: false, error: 'Client introuvable' }, 404);

  const carte = Array.isArray(data.cartes) ? data.cartes[0] : data.cartes;
  if (!carte?.actif) return c.json({ ok: false, recorded: false, error: 'Carte introuvable' }, 404);

  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 500) || null;
  const referrer = (c.req.header('referer') ?? c.req.header('referrer') ?? '').slice(0, 500) || null;
  const insertResult = await db
    .from('web_card_events')
    .insert({
      client_id: data.id,
      carte_id: data.carte_id,
      commerce_id: data.commerce_id,
      point_vente_id: data.point_vente_id,
      event_type: 'opened',
      user_agent: userAgent,
      referrer,
    });

  if (insertResult.error) {
    console.warn('[web-card open metric]', insertResult.error.message);
    return c.json({ ok: true, recorded: false });
  }

  return c.json({ ok: true, recorded: true });
});

/** GET /api/clients/:id — Récupère un client (utilisé par le scanner) */
clientsRoutes.get('/:id', authMiddleware, paidMiddleware, async (c) => {
  const clientId = c.req.param('id') ?? '';
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');

  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data, error } = await db
    .from('clients')
    .select('*, cartes(nom, type, tampons_total, points_recompense, recompense_description, rewards_multi_enabled, rewards_config)')
    .eq('id', clientId)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .single();

  if (error || !data) return c.json({ error: 'Client introuvable' }, 404);

  const carte = Array.isArray(data.cartes) ? data.cartes[0] : data.cartes;
  return c.json({
    data: {
      ...data,
      ...(carte?.type === 'points'
        ? { reward_state: getPointRewardState(data.points_actuels, carte) }
        : {}),
    },
  });
});

/** GET /api/clients — Liste les clients du commerce (paginé) */
clientsRoutes.get('/', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const search = c.req.query('search') ?? '';
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0'));
  const pageSize = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '100')), 500);
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');

  if (!commerce || !pointVente) return c.json({ data: [], total: 0, page: 0, pageSize });

  let query = db
    .from('clients')
    .select('*, cartes(type, points_recompense, recompense_description, rewards_multi_enabled, rewards_config)', { count: 'exact' })
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .order('derniere_visite', { ascending: false, nullsFirst: false });

  if (search) {
    query = query.or(`nom.ilike.%${search}%,email.ilike.%${search}%,telephone.ilike.%${search}%,wallet_code.ilike.%${search}%`);
  }

  const { data, error, count } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
  if (error) return c.json({ error: 'Erreur lors de la récupération' }, 500);

  const clients = (data ?? []).map((client) => {
    const carte = Array.isArray(client.cartes) ? client.cartes[0] : client.cartes;
    return {
      ...client,
      ...(usesMultiplePointRewards(carte ?? {})
        ? { reward_state: getPointRewardState(client.points_actuels, carte ?? {}) }
        : {}),
    };
  });

  return c.json({ data: clients, total: count ?? 0, page, pageSize });
});

/** POST /api/clients — Crée un client (lors de l'ajout au Wallet) */
clientsRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    carte_id: z.string().uuid(),
    nom: z.string().min(1, 'Le prénom est obligatoire').max(255),
    telephone: z.string().min(8, 'Le numéro de téléphone est obligatoire').max(20),
    email: z.string().email().nullable().optional(),
    date_naissance: z.preprocess(
      (value) => (value === '' ? null : value),
      z.string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu: AAAA-MM-JJ')
        .refine((d) => {
          const [year, month, day] = d.split('-').map(Number);
          const date = new Date(year, month - 1, day);
          return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
        }, 'Date invalide (ex: 30 février)')
        .nullable()
        .optional(),
    ),
    push_consent: z.boolean().default(false),
    fcm_token: z.string().nullable().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const normalizedPhone = normalizePhone(parsed.data.telephone);

  const { data: carte } = await db
    .from('cartes')
    .select('commerce_id, point_vente_id')
    .eq('id', parsed.data.carte_id)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  const { data: commerce } = await db
    .from('commerces')
    .select('id, plan, plan_override, nom, sms_welcome_enabled, sms_welcome_message, sms_credits')
    .eq('id', carte.commerce_id)
    .single();

  const { data: existingClient, error: existingClientError } = await db
    .from('clients')
    .select('*')
    .eq('carte_id', parsed.data.carte_id)
    .eq('commerce_id', carte.commerce_id)
    .eq('point_vente_id', carte.point_vente_id)
    .eq('telephone', normalizedPhone)
    .maybeSingle();

  if (existingClientError) {
    return c.json({ error: 'Erreur lors de la vérification du client' }, 500);
  }

  if (existingClient) {
    const nextFcmToken = parsed.data.fcm_token ?? existingClient.fcm_token;
    const pushEnabled = Boolean(nextFcmToken) && (parsed.data.push_consent || existingClient.push_enabled);

    const { data: updatedClient, error: updateError } = await db
      .from('clients')
      .update({
        nom: parsed.data.nom,
        telephone: normalizedPhone,
        email: parsed.data.email ?? existingClient.email,
        date_naissance: parsed.data.date_naissance ?? existingClient.date_naissance ?? null,
        fcm_token: nextFcmToken,
        push_enabled: pushEnabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingClient.id)
      .select()
      .single();

    if (updateError && updateError.message?.includes('date_naissance')) {
      const { data: fallbackUpdatedClient, error: fallbackUpdateError } = await db
        .from('clients')
        .update({
          nom: parsed.data.nom,
          telephone: normalizedPhone,
          email: parsed.data.email ?? existingClient.email,
          fcm_token: nextFcmToken,
          push_enabled: pushEnabled,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingClient.id)
        .select()
        .single();

      if (fallbackUpdateError || !fallbackUpdatedClient) {
        return c.json({ error: 'Erreur lors de la mise à jour du client' }, 500);
      }

      return c.json({ data: fallbackUpdatedClient, existing: true });
    }

    if (updateError || !updatedClient) {
      return c.json({ error: 'Erreur lors de la mise à jour du client' }, 500);
    }

    return c.json({ data: updatedClient, existing: true });
  }

  // Vérification limite de cartes selon plan uniquement pour une nouvelle carte client.
  if (commerce) {
    const limits = getPlanLimits(getEffectivePlanRaw(commerce));
    const { count: activeCount } = await db
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('commerce_id', commerce.id);

    if (typeof limits.maxClients === 'number' && (activeCount ?? 0) >= limits.maxClients) {
      return c.json({
        error: `Limite de ${limits.maxClients} cartes actives atteinte pour votre plan. Passez au plan supérieur pour continuer.`,
      }, 403);
    }
  }

  let insertResult = await db
    .from('clients')
    .insert({
      carte_id: parsed.data.carte_id,
      commerce_id: carte.commerce_id,
      point_vente_id: carte.point_vente_id,
      wallet_code: generateWalletCode(),
      nom: parsed.data.nom,
      telephone: normalizedPhone,
      email: parsed.data.email ?? null,
      date_naissance: parsed.data.date_naissance ?? null,
      fcm_token: parsed.data.fcm_token ?? null,
      push_enabled: parsed.data.push_consent && Boolean(parsed.data.fcm_token),
    })
    .select()
    .single();

  if (insertResult.error?.message?.includes('date_naissance')) {
    insertResult = await db
      .from('clients')
      .insert({
        carte_id: parsed.data.carte_id,
        commerce_id: carte.commerce_id,
        point_vente_id: carte.point_vente_id,
        wallet_code: generateWalletCode(),
        nom: parsed.data.nom,
        telephone: normalizedPhone,
        email: parsed.data.email ?? null,
        fcm_token: parsed.data.fcm_token ?? null,
        push_enabled: parsed.data.push_consent && Boolean(parsed.data.fcm_token),
      })
      .select()
      .single();
  }

  const { data, error } = insertResult;
  if (error) return c.json({ error: 'Erreur lors de la création du client' }, 500);

  // SMS bienvenue planifié 60 min après l'inscription
  if (commerce && commerce.sms_welcome_enabled && (commerce.sms_credits ?? 0) > 0 && data.telephone) {
    const defaultMsg = 'Bonjour {prenom} ! Bienvenue chez {commerce}. Retrouvez votre carte de fidélité ici : {lien_carte}';
    const msg = personnaliserMessage(
      (commerce.sms_welcome_message as string | null) ?? defaultMsg,
      {
        prenom: data.nom ?? '',
        commerce: (commerce.nom as string | null) ?? '',
        lien_carte: `${PUBLIC_SITE_URL}/carte/${data.id}`,
      },
    );
    scheduleSMS(data.telephone, msg, commerce.id, data.id, 'bienvenue', 60)
      .catch((err) => console.error('[clients] scheduleSMS bienvenue:', err));
  }

  return c.json({ data }, 201);
});

/** PATCH /api/clients/:id/adjust — Ajustement manuel du score (+ ou -) par le commerçant */
clientsRoutes.patch('/:id/adjust', authMiddleware, paidMiddleware, async (c) => {
  const clientId = c.req.param('id') ?? '';
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const schema = z.object({
    delta: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'Delta ne peut pas être 0'),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);

  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(db, userId, requestedPointVenteId, 'id, plan');
  if (!commerce || !pointVente) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: client } = await db
    .from('clients')
    .select('*, cartes(type, tampons_total, points_recompense, recompense_description, rewards_multi_enabled, rewards_config)')
    .eq('id', clientId)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .single();
  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  const carte = Array.isArray(client.cartes) ? client.cartes[0] : client.cartes;
  const isPoints = carte?.type === 'points';
  const scoreType = isPoints ? 'points' : 'tampons';
  const seuil = isPoints ? (carte?.points_recompense ?? 100) : (carte?.tampons_total ?? 10);
  const current = isPoints ? client.points_actuels : client.tampons_actuels;
  const type = parsed.data.delta > 0
    ? (isPoints ? 'ajout_points' : 'ajout_tampon')
    : (isPoints ? 'retrait_points' : 'retrait_tampon');

  let updated: { points_actuels: number; tampons_actuels: number; recompenses_obtenues: number };
  if (usesMultiplePointRewards(carte ?? {})) {
    const nextPoints = Math.max(0, (client.points_actuels ?? 0) + parsed.data.delta);
    const { data: updateData, error: updateError } = await db
      .from('clients')
      .update({
        points_actuels: nextPoints,
        derniere_visite: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', clientId)
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .eq('points_actuels', client.points_actuels ?? 0)
      .select('points_actuels, tampons_actuels, recompenses_obtenues')
      .maybeSingle();
    if (updateError) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);
    if (!updateData) return c.json({ error: 'La fiche client vient déjà d’être modifiée. Rechargez le client.' }, 409);
    updated = updateData;
  } else {
    // Mise à jour atomique via RPC pour éviter les race conditions sur les scans simultanés
    const { data: rpcResult, error: rpcError } = await db.rpc('adjust_client_score_atomic', {
      p_client_id: clientId,
      p_commerce_id: commerce.id,
      p_delta: parsed.data.delta,
      p_score_type: scoreType,
      p_seuil: seuil,
    });
    if (rpcError) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);
    updated = rpcResult as { points_actuels: number; tampons_actuels: number; recompenses_obtenues: number };
  }
  const finalScore = isPoints ? updated.points_actuels : updated.tampons_actuels;

  await db.from('transactions').insert({
    client_id: clientId,
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
    type,
    valeur: Math.abs(parsed.data.delta),
    points_avant: current,
    points_apres: finalScore,
    note: 'Ajustement manuel',
  });

  // Mise à jour Wallet en fire-and-forget (ne bloque pas la réponse)
  const { data: clientFull } = await db
    .from('clients')
    .select('apple_pass_serial, google_pass_id')
    .eq('id', clientId)
    .single();

  if (clientFull) {
    // Google Wallet
    if (clientFull.google_pass_id && carte) {
      const { data: commerceData } = await db
        .from('commerces')
        .select('nom, logo_url, plan')
        .eq('id', commerce.id)
        .single();

      const { data: pointVenteData } = await db
        .from('points_vente')
        .select('latitude, longitude, rayon_geo')
        .eq('id', pointVente.id)
        .maybeSingle();

      const carteForWallet = {
        ...carte,
        id: client.carte_id ?? '',
        nom: (client.cartes as { nom?: string } | null)?.nom ?? '',
        commerces: {
          nom: commerceData?.nom ?? '',
          logo_url: commerceData?.logo_url ?? null,
          latitude: pointVenteData?.latitude ?? null,
          longitude: pointVenteData?.longitude ?? null,
          rayon_geo: pointVenteData?.rayon_geo ?? null,
          plan: commerceData?.plan ?? 'starter',
        },
      } as Parameters<typeof updateGooglePassObject>[1];

      updateGooglePassObject(clientFull.google_pass_id, carteForWallet, {
        id: clientId,
        nom: client.nom ?? null,
        points_actuels: updated.points_actuels,
        tampons_actuels: updated.tampons_actuels,
        recompenses_obtenues: updated.recompenses_obtenues,
      }).catch((err) => console.error('[adjust wallet google]', err));
    }

    // Apple Wallet
    if (clientFull.apple_pass_serial) {
      const { data: registrations } = await db
        .from('apple_pass_registrations')
        .select('push_token, pass_type_identifier')
        .eq('client_id', clientId);

      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      for (const reg of uniqueRegistrations) {
        pushApplePassUpdate(reg.push_token, passTypeId || reg.pass_type_identifier)
          .catch((err) => console.error('[adjust wallet apple]', err));
      }
    }
  }

  return c.json({
    client: {
      points_actuels: updated.points_actuels,
      tampons_actuels: updated.tampons_actuels,
      recompenses_obtenues: updated.recompenses_obtenues,
      ...(isPoints && carte ? { reward_state: getPointRewardState(updated.points_actuels, carte) } : {}),
    },
  });
});

/** POST /api/clients/:id/claim-review — Réclame la récompense avis Google */
clientsRoutes.post('/:id/claim-review', async (c) => {
  const clientId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);

  const schema = z.object({ carte_id: z.string().uuid() });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'carte_id requis' }, 400);

  const db = createServiceClient();

  const { data: client } = await db
    .from('clients')
    .select('id, nom, commerce_id, point_vente_id, carte_id, points_actuels, tampons_actuels, recompenses_obtenues, google_pass_id, apple_pass_serial')
    .eq('id', clientId)
    .eq('carte_id', parsed.data.carte_id)
    .single();

  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  const { data: carte } = await db
    .from('cartes')
    .select('id, commerce_id, type, tampons_total, points_recompense, recompense_description, rewards_multi_enabled, rewards_config, review_reward_enabled, review_reward_value, couleur_fond, logo_url, strip_url, barcode_type, label_client, commerces(nom, logo_url, plan, plan_override)')
    .eq('id', parsed.data.carte_id)
    .eq('commerce_id', client.commerce_id)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);
  if (!carte.review_reward_enabled) return c.json({ error: 'Récompense avis non activée' }, 403);
  const commerceRef = Array.isArray(carte.commerces) ? carte.commerces[0] : carte.commerces;
  if (!getPlanLimits(getEffectivePlanRaw(commerceRef)).avisGoogle) {
    return c.json({ error: 'Fonctionnalité réservée aux plans Pro et Business' }, 403);
  }

  const { data: existing } = await db
    .from('review_rewards')
    .select('id')
    .eq('client_id', clientId)
    .eq('carte_id', parsed.data.carte_id)
    .maybeSingle();

  if (existing) return c.json({ error: 'Récompense déjà réclamée' }, 409);

  // Insérer la réclamation
  const claimResult = await db.from('review_rewards').insert({
    client_id: clientId,
    carte_id: parsed.data.carte_id,
    commerce_id: client.commerce_id,
  });

  if (claimResult.error) {
    if (claimResult.error.code === '23505') {
      return c.json({ error: 'Récompense déjà réclamée' }, 409);
    }
    return c.json({ error: 'Erreur lors de la réclamation' }, 500);
  }

  const rewardValue = carte.review_reward_value ?? 1;
  const progress = applyProgressIncrement(carte, client, rewardValue);

  const updateResult = await db.from('clients').update({
    points_actuels: progress.newPoints,
    tampons_actuels: progress.newTampons,
    recompenses_obtenues: progress.recompensesObtenues,
    updated_at: new Date().toISOString(),
  }).eq('id', clientId);

  if (updateResult.error) {
    await db.from('review_rewards').delete().eq('client_id', clientId).eq('carte_id', parsed.data.carte_id);
    return c.json({ error: 'Erreur lors du crédit de la récompense' }, 500);
  }

  await db.from('transactions').insert({
    client_id: clientId,
    commerce_id: client.commerce_id,
    point_vente_id: client.point_vente_id,
    type: carte.type === 'tampons' ? 'ajout_tampon' : 'ajout_points',
    valeur: rewardValue,
    points_avant: progress.activeScoreBefore,
    points_apres: progress.activeScoreAfter,
    note: 'Récompense avis Google',
  });

  const updatedClient = {
    ...client,
    points_actuels: progress.newPoints,
    tampons_actuels: progress.newTampons,
    recompenses_obtenues: progress.recompensesObtenues,
  };

  if (client.google_pass_id) {
    updateGooglePassObject(
      client.google_pass_id,
      carte as unknown as Parameters<typeof updateGooglePassObject>[1],
      updatedClient,
    ).catch((err) => console.error('[clients claim-review google]', err));
  }

  if (client.apple_pass_serial) {
    void (async () => {
      const { data } = await db.from('apple_pass_registrations')
        .select('push_token, pass_type_identifier')
        .eq('client_id', clientId);
      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((data ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      await Promise.allSettled(
        uniqueRegistrations.map((registration) =>
          pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
        ),
      );
    })().catch((err: unknown) => console.error('[clients claim-review apple]', err));
  }

  return c.json({
    ok: true,
    reward_value: rewardValue,
    type: carte.type,
    client: {
      points_actuels: progress.newPoints,
      tampons_actuels: progress.newTampons,
      recompenses_obtenues: progress.recompensesObtenues,
      ...(carte.type === 'points'
        ? { reward_state: getPointRewardState(progress.newPoints, carte) }
        : {}),
    },
  });
});

const webPushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256),
  }),
});

async function saveWebPushSubscription(c: any) {
  const clientId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);

  const schema = z.object({
    subscription: webPushSubscriptionSchema,
    carte_id: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Abonnement push invalide' }, 400);

  const db = createServiceClient();

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('id, carte_id, commerce_id, point_vente_id')
    .eq('id', clientId)
    .maybeSingle();

  if (clientError) return c.json({ error: 'Erreur lors de la vérification du client' }, 500);
  if (!client || (parsed.data.carte_id && client.carte_id !== parsed.data.carte_id)) {
    return c.json({ error: 'Client introuvable pour cette carte' }, 404);
  }

  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 500) || null;
  const { endpoint, keys } = parsed.data.subscription;

  const { error: subscriptionError } = await db
    .from('web_push_subscriptions')
    .upsert({
      client_id: client.id,
      carte_id: client.carte_id,
      commerce_id: client.commerce_id,
      point_vente_id: client.point_vente_id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: userAgent,
      enabled: true,
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

  if (subscriptionError) {
    console.error('[web-push subscription]', subscriptionError);
    return c.json({ error: 'Erreur lors de l’enregistrement des notifications' }, 500);
  }

  const { data: updatedClient, error: updateError } = await db
    .from('clients')
    .update({ fcm_token: null, push_enabled: true })
    .eq('id', clientId)
    .select('id')
    .maybeSingle();

  if (updateError) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);
  if (!updatedClient) return c.json({ error: 'Client introuvable' }, 404);

  return c.json({ ok: true });
}

/** PATCH /api/clients/:id/web-push — Enregistre l'abonnement Web Push natif */
clientsRoutes.patch('/:id/web-push', saveWebPushSubscription);
