import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { updateGooglePassObject } from '../services/google-wallet';
import { applyProgressIncrement } from '../services/loyalty-progress';
import { getPointRewardState } from '../services/point-rewards';
import { getPlanLimits } from './commerces';
import { getEffectivePlanRaw } from '../utils/effective-plan';

export const reviewRoutes = new Hono<ApiEnv>();

const claimSchema = z.object({
  client_id: z.string().uuid(),
});

/** GET /api/review/:carteId/info?client_id=... — Infos de la carte + statut réclamation */
reviewRoutes.get('/:carteId/info', async (c) => {
  const carteId = c.req.param('carteId');
  const clientId = c.req.query('client_id');

  if (!clientId) return c.json({ error: 'client_id manquant' }, 400);

  const db = createServiceClient();

  const { data: carte } = await db
    .from('cartes')
    .select('id, nom, type, review_reward_enabled, review_reward_value, google_maps_url, commerces(nom, logo_url, plan, plan_override)')
    .eq('id', carteId)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);
  if (!carte.review_reward_enabled) return c.json({ error: 'Fonctionnalité non activée' }, 403);
  const commerceRef = Array.isArray(carte.commerces) ? carte.commerces[0] : carte.commerces;
  if (!getPlanLimits(getEffectivePlanRaw(commerceRef)).avisGoogle) {
    return c.json({ error: 'Fonctionnalité réservée aux plans Pro et Business' }, 403);
  }

  // Vérifie que le client appartient bien à cette carte
  const { data: client } = await db
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('carte_id', carteId)
    .single();

  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  // Vérifie si déjà réclamé
  const { data: existing } = await db
    .from('review_rewards')
    .select('claimed_at')
    .eq('client_id', clientId)
    .eq('carte_id', carteId)
    .maybeSingle();

  return c.json({
    data: {
      carte: {
        nom: carte.nom,
        type: carte.type,
        review_reward_value: carte.review_reward_value,
        google_maps_url: carte.google_maps_url,
        commerce_nom: commerceRef?.nom ?? '',
        commerce_logo: commerceRef?.logo_url ?? null,
      },
      already_claimed: !!existing,
      claimed_at: existing?.claimed_at ?? null,
    },
  });
});

/** POST /api/review/:carteId/claim — Réclame la récompense (bouton d'honneur) */
reviewRoutes.post('/:carteId/claim', async (c) => {
  const carteId = c.req.param('carteId');
  const body = await c.req.json().catch(() => null);
  const parsed = claimSchema.safeParse(body);

  if (!parsed.success) return c.json({ error: 'client_id manquant ou invalide' }, 400);

  const { client_id } = parsed.data;
  const db = createServiceClient();

  // Vérifie la carte
  const { data: carte } = await db
    .from('cartes')
    .select('id, type, tampons_total, points_recompense, recompense_description, rewards_multi_enabled, rewards_config, review_reward_enabled, review_reward_value, couleur_fond, logo_url, strip_url, barcode_type, label_client, commerces(nom, logo_url, plan, plan_override)')
    .eq('id', carteId)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);
  if (!carte.review_reward_enabled) return c.json({ error: 'Fonctionnalité non activée' }, 403);
  const commerceRef = Array.isArray(carte.commerces) ? carte.commerces[0] : carte.commerces;
  if (!getPlanLimits(getEffectivePlanRaw(commerceRef)).avisGoogle) {
    return c.json({ error: 'Fonctionnalité réservée aux plans Pro et Business' }, 403);
  }

  // Vérifie que le client appartient bien à cette carte
  const { data: client } = await db
    .from('clients')
    .select('*')
    .eq('id', client_id)
    .eq('carte_id', carteId)
    .single();

  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  // Vérifie si déjà réclamé (UNIQUE constraint côté DB, mais on vérifie avant pour un message clair)
  const { data: existing } = await db
    .from('review_rewards')
    .select('id')
    .eq('client_id', client_id)
    .eq('carte_id', carteId)
    .maybeSingle();

  if (existing) return c.json({ error: 'Récompense déjà réclamée pour cette carte' }, 409);

  const rewardValue = carte.review_reward_value ?? 1;
  const progress = applyProgressIncrement(carte, client, rewardValue);
  const newPoints = progress.newPoints;
  const newTampons = progress.newTampons;
  const recompensesObtenues = progress.recompensesObtenues;

  const claimResult = await db.from('review_rewards').insert({
    client_id,
    carte_id: carteId,
    commerce_id: client.commerce_id,
  });
  if (claimResult.error) {
    // Contrainte UNIQUE déclenchée en concurrence
    if (claimResult.error.code === '23505') {
      return c.json({ error: 'Récompense déjà réclamée pour cette carte' }, 409);
    }
    return c.json({ error: 'Erreur lors de l\'enregistrement' }, 500);
  }

  const updateResult = await db.from('clients').update({
    points_actuels: newPoints,
    tampons_actuels: newTampons,
    recompenses_obtenues: recompensesObtenues,
    updated_at: new Date().toISOString(),
  }).eq('id', client_id);

  if (updateResult.error) {
    await db.from('review_rewards').delete().eq('client_id', client_id).eq('carte_id', carteId);
    return c.json({ error: 'Erreur lors du crédit de la récompense' }, 500);
  }

  const transactionResult = await db.from('transactions').insert({
    client_id,
    commerce_id: client.commerce_id,
    point_vente_id: client.point_vente_id,
    type: carte.type === 'tampons' ? 'ajout_tampon' : 'ajout_points',
    valeur: rewardValue,
    points_avant: progress.activeScoreBefore,
    points_apres: progress.activeScoreAfter,
    note: 'Récompense avis Google',
  }).select().single();

  if (transactionResult.error) {
    console.error('[review claim transaction]', transactionResult.error);
  }

  // Mise à jour Wallets (fire-and-forget)
  void (async () => {
    try {
      const updatedClient = { ...client, points_actuels: newPoints, tampons_actuels: newTampons, recompenses_obtenues: recompensesObtenues };

      if (client.google_pass_id) {
        await updateGooglePassObject(
          client.google_pass_id,
          carte as unknown as Parameters<typeof updateGooglePassObject>[1],
          updatedClient,
        ).catch((err) => console.error('[review claim google]', err));
      }

      if (client.apple_pass_serial) {
        const { data: registrations } = await db
          .from('apple_pass_registrations')
          .select('push_token, pass_type_identifier')
          .eq('client_id', client_id);

        if (registrations?.length) {
          const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
          const uniqueRegistrations = Array.from(
            new Map(registrations.map((registration) => [registration.push_token, registration])).values(),
          );
          await Promise.allSettled(
            uniqueRegistrations.map((r) => pushApplePassUpdate(r.push_token, passTypeId || r.pass_type_identifier)),
          );
        }
      }
    } catch (err) {
      console.error('[review claim wallet-sync]', err);
    }
  })();

  return c.json({
    data: {
      client: { points_actuels: newPoints, tampons_actuels: newTampons, recompenses_obtenues: recompensesObtenues },
      ...(carte.type === 'points' ? { reward_state: getPointRewardState(newPoints, carte) } : {}),
      transaction: transactionResult.data,
      reward_value: rewardValue,
      type: carte.type,
    },
  }, 201);
});
