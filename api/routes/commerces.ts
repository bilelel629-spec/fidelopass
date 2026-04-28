import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { geocodeAddress } from '../services/geocoding';
import { syncWalletForPointVente } from '../services/wallet-sync';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

export const commercesRoutes = new Hono();

commercesRoutes.use('*', authMiddleware);
commercesRoutes.use('/me', paidMiddleware);
commercesRoutes.use('/points-vente*', paidMiddleware);

const updateSchema = z.object({
  nom: z.string().min(2).max(255).optional(),
  adresse: z.string().max(500).nullable().optional(),
  telephone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  logo_url: z.string().url().nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
  onboarding_completed: z.boolean().optional(),
  point_vente_nom: z.string().min(2).max(255).optional(),
});

const pointVenteCreateSchema = z.object({
  nom: z.string().min(2).max(255),
  adresse: z.string().max(500).nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
});

const pointVenteUpdateSchema = z.object({
  nom: z.string().min(2).max(255).optional(),
  adresse: z.string().max(500).nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
  principal: z.boolean().optional(),
});

export const PLAN_LIMITS = {
  starter: { maxClients: 500, maxPointsDeVente: 1, anniversaire: false, avisGoogle: false, maxScanners: 3 },
  pro:     { maxClients: 2000, maxPointsDeVente: 3, anniversaire: true,  avisGoogle: true,  maxScanners: 6 },
  'sur-mesure': { maxClients: 20000, maxPointsDeVente: 10, anniversaire: true, avisGoogle: true, maxScanners: 20 },
} as const;

export function normalizePlan(plan: string | null | undefined): keyof typeof PLAN_LIMITS {
  const normalized = String(plan ?? 'starter')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');

  if (!normalized) return 'starter';
  if (normalized === 'starter' || normalized.startsWith('starter-') || normalized.includes('starter')) return 'starter';
  if (normalized === 'pro' || normalized.startsWith('pro-') || normalized.includes('pro')) return 'pro';
  if (
    normalized === 'sur-mesure'
    || normalized.includes('sur-mesure')
    || normalized.includes('surmesure')
    || normalized.includes('custom')
    || normalized.includes('enterprise')
  ) return 'sur-mesure';
  return 'starter';
}

export function getPlanLimits(plan: string | null | undefined) {
  return PLAN_LIMITS[normalizePlan(plan)];
}

function computeGeoReadiness(payload: {
  adresse?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rayon_geo?: number | null;
}) {
  const hasAddress = !!String(payload.adresse ?? '').trim();
  const hasCoordinates = typeof payload.latitude === 'number' && typeof payload.longitude === 'number';
  const hasValidRadius = typeof payload.rayon_geo === 'number' && Number.isFinite(payload.rayon_geo) && payload.rayon_geo >= 100;

  const ready = hasAddress && hasCoordinates && hasValidRadius;
  let reason = 'ready';
  if (!hasAddress) reason = 'address_missing';
  else if (!hasCoordinates) reason = 'coordinates_missing';
  else if (!hasValidRadius) reason = 'radius_invalid';

  return { ready, reason };
}

/** GET /api/commerces/me — Récupère le commerce de l'utilisateur connecté */
commercesRoutes.get('/me', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  try {
    const { commerce, pointVente, pointsVente } = await resolveCommerceAndPointVente(
      db,
      userId,
      requestedPointVenteId,
      '*',
    );

    if (!commerce) return c.json({ data: null });

    const mergedCommerce = {
      ...commerce,
      adresse: pointVente?.adresse ?? commerce.adresse ?? null,
      latitude: pointVente?.latitude ?? commerce.latitude ?? null,
      longitude: pointVente?.longitude ?? commerce.longitude ?? null,
      rayon_geo: pointVente?.rayon_geo ?? commerce.rayon_geo ?? 1000,
      point_vente_id: pointVente?.id ?? null,
      point_vente_nom: pointVente?.nom ?? commerce.nom ?? null,
      points_vente_count: pointsVente.length,
      points_vente: pointsVente,
      geo: computeGeoReadiness({
        adresse: pointVente?.adresse ?? commerce.adresse ?? null,
        latitude: pointVente?.latitude ?? commerce.latitude ?? null,
        longitude: pointVente?.longitude ?? commerce.longitude ?? null,
        rayon_geo: pointVente?.rayon_geo ?? commerce.rayon_geo ?? 1000,
      }),
    };

    return c.json({ data: mergedCommerce });
  } catch (error) {
    console.error('[commerces /me]', error);
    return c.json({ error: 'Erreur lors de la récupération du commerce' }, 500);
  }
});

/** POST /api/commerces — Crée le commerce de l'utilisateur */
commercesRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);

  const createSchema = updateSchema.extend({
    nom: z.string().min(2).max(255),
  });
  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();

  // Un seul commerce par utilisateur
  const { data: existing } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (existing) {
    return c.json({ error: 'Vous avez déjà un commerce enregistré' }, 409);
  }

  const { point_vente_nom: _ignorePointVenteNom, ...commerceInsertPayload } = parsed.data;

  const { data, error } = await db
    .from('commerces')
    .insert({ ...commerceInsertPayload, user_id: userId })
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la création' }, 500);

  const principalPointNom = `${parsed.data.nom} — Principal`;
  const coords = parsed.data.adresse ? await geocodeAddress(parsed.data.adresse) : null;
  await db
    .from('points_vente')
    .insert({
      commerce_id: data.id,
      nom: principalPointNom,
      adresse: parsed.data.adresse ?? null,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      rayon_geo: parsed.data.rayon_geo ?? 1000,
      principal: true,
      actif: true,
    });

  return c.json({ data }, 201);
});

/** PATCH /api/commerces/me — Met à jour le commerce + géocode l'adresse si modifiée */
commercesRoutes.patch('/me', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointVente, pointsVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, nom, telephone, email, logo_url, onboarding_completed, plan, rayon_geo, adresse, latitude, longitude',
  );

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);
  if (!pointVente) return c.json({ error: 'Point de vente introuvable' }, 404);

  // Champs commerce (globaux)
  const commercePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.nom !== undefined) commercePayload.nom = parsed.data.nom;
  if (parsed.data.telephone !== undefined) commercePayload.telephone = parsed.data.telephone;
  if (parsed.data.email !== undefined) commercePayload.email = parsed.data.email;
  if (parsed.data.logo_url !== undefined) commercePayload.logo_url = parsed.data.logo_url;
  if (parsed.data.onboarding_completed !== undefined) commercePayload.onboarding_completed = parsed.data.onboarding_completed;

  // Champs point de vente (spécifiques à la carte sélectionnée)
  const pointPayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.point_vente_nom !== undefined) pointPayload.nom = parsed.data.point_vente_nom;
  if (parsed.data.adresse !== undefined) pointPayload.adresse = parsed.data.adresse;
  if (parsed.data.rayon_geo !== undefined) pointPayload.rayon_geo = parsed.data.rayon_geo;

  if (parsed.data.adresse) {
    const coords = await geocodeAddress(parsed.data.adresse);
    if (coords) {
      pointPayload.latitude = coords.latitude;
      pointPayload.longitude = coords.longitude;
      // Maintien des colonnes legacy au niveau commerce pour compatibilité
      commercePayload.latitude = coords.latitude;
      commercePayload.longitude = coords.longitude;
      commercePayload.adresse = parsed.data.adresse;
    }
  }

  if (Object.keys(commercePayload).length > 1) {
    const { error: commerceError } = await db
      .from('commerces')
      .update(commercePayload)
      .eq('id', commerce.id);
    if (commerceError) return c.json({ error: 'Erreur lors de la mise à jour du commerce' }, 500);
  }

  if (Object.keys(pointPayload).length > 1) {
    const { error: pointError } = await db
      .from('points_vente')
      .update(pointPayload)
      .eq('id', pointVente.id)
      .eq('commerce_id', commerce.id);
    if (pointError) return c.json({ error: 'Erreur lors de la mise à jour du point de vente' }, 500);
  }

  const { data: updatedPoint } = await db
    .from('points_vente')
    .select('id, commerce_id, nom, adresse, latitude, longitude, rayon_geo, principal, actif, created_at')
    .eq('id', pointVente.id)
    .single();

  const finalPointVenteId = updatedPoint?.id ?? pointVente.id;
  void syncWalletForPointVente(finalPointVenteId)
    .then((stats) => {
      if (stats.cartes > 0) {
        console.info('[geolocation wallet-sync] /commerces/me', { point_vente_id: finalPointVenteId, ...stats });
      }
    })
    .catch((err) => {
      console.error('[geolocation wallet-sync] /commerces/me', err);
    });

  return c.json({
    data: {
      ...commerce,
      ...commercePayload,
      adresse: updatedPoint?.adresse ?? parsed.data.adresse ?? null,
      latitude: updatedPoint?.latitude ?? null,
      longitude: updatedPoint?.longitude ?? null,
      rayon_geo: updatedPoint?.rayon_geo ?? parsed.data.rayon_geo ?? 1000,
      point_vente_id: updatedPoint?.id ?? pointVente.id,
      point_vente_nom: updatedPoint?.nom ?? pointVente.nom,
      points_vente_count: pointsVente.length,
      geo: computeGeoReadiness({
        adresse: updatedPoint?.adresse ?? parsed.data.adresse ?? null,
        latitude: updatedPoint?.latitude ?? null,
        longitude: updatedPoint?.longitude ?? null,
        rayon_geo: updatedPoint?.rayon_geo ?? parsed.data.rayon_geo ?? 1000,
      }),
    },
  });
});

/** GET /api/commerces/points-vente — Liste des points de vente */
commercesRoutes.get('/points-vente', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente, pointsVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce) return c.json({ data: [], selected_point_vente_id: null });

  const effectivePlan = getEffectivePlanRaw(commerce);
  const limits = getPlanLimits(effectivePlan);
  return c.json({
    data: pointsVente,
    selected_point_vente_id: pointVente?.id ?? null,
    plan: effectivePlan,
    raw_plan: commerce.plan ?? 'starter',
    plan_override: commerce.plan_override ?? null,
    limits,
    usage: {
      current: pointsVente.length,
      max: limits.maxPointsDeVente,
      remaining: Math.max(limits.maxPointsDeVente - pointsVente.length, 0),
    },
  });
});

/** POST /api/commerces/points-vente — Ajout d'un point de vente (quota plan) */
commercesRoutes.post('/points-vente', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = pointVenteCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointsVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    null,
    'id, plan',
  );

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const effectivePlan = getEffectivePlanRaw(commerce);
  const limits = getPlanLimits(effectivePlan);
  if (pointsVente.length >= limits.maxPointsDeVente) {
    return c.json({
      error: `Limite atteinte: votre plan ${effectivePlan} autorise ${limits.maxPointsDeVente} point(s) de vente.`,
      code: 'POINTS_VENTE_LIMIT_REACHED',
      data: { max: limits.maxPointsDeVente, current: pointsVente.length },
    }, 403);
  }

  const coords = parsed.data.adresse ? await geocodeAddress(parsed.data.adresse) : null;
  const { data, error } = await db
    .from('points_vente')
    .insert({
      commerce_id: commerce.id,
      nom: parsed.data.nom,
      adresse: parsed.data.adresse ?? null,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      rayon_geo: parsed.data.rayon_geo ?? 1000,
      principal: pointsVente.length === 0,
      actif: true,
    })
    .select()
    .single();

  if (error) return c.json({ error: 'Impossible de créer ce point de vente.' }, 500);
  return c.json({
    data,
    geo: computeGeoReadiness({
      adresse: data.adresse ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      rayon_geo: data.rayon_geo ?? 1000,
    }),
  }, 201);
});

/** PATCH /api/commerces/points-vente/:id — Modifier un point de vente */
commercesRoutes.patch('/points-vente/:id', async (c) => {
  const userId = c.get('userId') as string;
  const pointVenteId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = pointVenteUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce } = await resolveCommerceAndPointVente(db, userId, null, 'id, plan');
  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: existingPoint } = await db
    .from('points_vente')
    .select('id, principal')
    .eq('id', pointVenteId)
    .eq('commerce_id', commerce.id)
    .single();
  if (!existingPoint) return c.json({ error: 'Point de vente introuvable' }, 404);

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.nom !== undefined) payload.nom = parsed.data.nom;
  if (parsed.data.adresse !== undefined) payload.adresse = parsed.data.adresse;
  if (parsed.data.rayon_geo !== undefined) payload.rayon_geo = parsed.data.rayon_geo;

  if (parsed.data.adresse) {
    const coords = await geocodeAddress(parsed.data.adresse);
    if (coords) {
      payload.latitude = coords.latitude;
      payload.longitude = coords.longitude;
    }
  }

  if (parsed.data.principal === true && !existingPoint.principal) {
    await db
      .from('points_vente')
      .update({ principal: false, updated_at: new Date().toISOString() })
      .eq('commerce_id', commerce.id);
    payload.principal = true;
  }

  const { data, error } = await db
    .from('points_vente')
    .update(payload)
    .eq('id', pointVenteId)
    .eq('commerce_id', commerce.id)
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la mise à jour du point de vente.' }, 500);
  void syncWalletForPointVente(data.id)
    .then((stats) => {
      if (stats.cartes > 0) {
        console.info('[geolocation wallet-sync] /points-vente/:id', { point_vente_id: data.id, ...stats });
      }
    })
    .catch((err) => {
      console.error('[geolocation wallet-sync] /points-vente/:id', err);
    });

  return c.json({
    data,
    geo: computeGeoReadiness({
      adresse: data.adresse ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      rayon_geo: data.rayon_geo ?? 1000,
    }),
  });
});

/** DELETE /api/commerces/points-vente/:id — Archive un point de vente */
commercesRoutes.delete('/points-vente/:id', async (c) => {
  const userId = c.get('userId') as string;
  const pointVenteId = c.req.param('id');
  const db = createServiceClient();

  const { commerce } = await resolveCommerceAndPointVente(db, userId, null, 'id');
  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const { data: activePoints } = await db
    .from('points_vente')
    .select('id, principal')
    .eq('commerce_id', commerce.id)
    .eq('actif', true)
    .order('principal', { ascending: false })
    .order('created_at', { ascending: true });

  const currentPoints = activePoints ?? [];
  const targetPoint = currentPoints.find((point) => point.id === pointVenteId);
  if (!targetPoint) return c.json({ error: 'Point de vente introuvable' }, 404);

  if (currentPoints.length <= 1) {
    return c.json({ error: 'Vous devez conserver au moins un point de vente actif.' }, 400);
  }

  const [{ count: linkedCards }, { count: linkedClients }] = await Promise.all([
    db.from('cartes').select('id', { count: 'exact', head: true }).eq('point_vente_id', pointVenteId),
    db.from('clients').select('id', { count: 'exact', head: true }).eq('point_vente_id', pointVenteId),
  ]);

  if ((linkedCards ?? 0) > 0 || (linkedClients ?? 0) > 0) {
    return c.json({
      error: 'Ce point de vente contient déjà des données clients/cartes. Archivez-le plus tard après migration des données.',
    }, 409);
  }

  const { error: archiveError } = await db
    .from('points_vente')
    .update({ actif: false, principal: false, updated_at: new Date().toISOString() })
    .eq('id', pointVenteId)
    .eq('commerce_id', commerce.id);
  if (archiveError) return c.json({ error: 'Impossible d’archiver ce point de vente.' }, 500);

  if (targetPoint.principal) {
    const nextPoint = currentPoints.find((point) => point.id !== pointVenteId);
    if (nextPoint) {
      await db
        .from('points_vente')
        .update({ principal: true, updated_at: new Date().toISOString() })
        .eq('id', nextPoint.id)
        .eq('commerce_id', commerce.id);
    }
  }

  return c.json({ ok: true });
});
