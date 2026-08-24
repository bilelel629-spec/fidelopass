import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { geocodeAddress } from '../services/geocoding';
import { syncWalletForPointVente } from '../services/wallet-sync';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';
import { getWelcomeEmailSender, sendWelcomeEmail } from '../services/welcome-email';
import { findAuthUserByEmail, isMissingCommerceMembersTable, normalizeMemberEmail } from '../utils/commerce-access';

export const commercesRoutes = new Hono<ApiEnv>();

commercesRoutes.use('*', authMiddleware);
commercesRoutes.use('/me', paidMiddleware);
commercesRoutes.use('/me/*', paidMiddleware);
commercesRoutes.use('/members', paidMiddleware);
commercesRoutes.use('/members/*', paidMiddleware);
commercesRoutes.use('/points-vente*', paidMiddleware);

const updateSchema = z.object({
  nom: z.string().min(2).max(255).optional(),
  adresse: z.string().max(500).nullable().optional(),
  rue: z.string().max(255).nullable().optional(),
  ville: z.string().max(120).nullable().optional(),
  code_postal: z.string().max(20).nullable().optional(),
  pays: z.string().max(80).nullable().optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
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
  rue: z.string().max(255).nullable().optional(),
  ville: z.string().max(120).nullable().optional(),
  code_postal: z.string().max(20).nullable().optional(),
  pays: z.string().max(80).nullable().optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
});

const pointVenteUpdateSchema = z.object({
  nom: z.string().min(2).max(255).optional(),
  adresse: z.string().max(500).nullable().optional(),
  rue: z.string().max(255).nullable().optional(),
  ville: z.string().max(120).nullable().optional(),
  code_postal: z.string().max(20).nullable().optional(),
  pays: z.string().max(80).nullable().optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
  principal: z.boolean().optional(),
});

const memberCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'staff']).default('staff'),
});

const memberUpdateSchema = z.object({
  role: z.enum(['admin', 'staff']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const PLAN_LIMITS = {
  starter: { maxClients: 500, maxPointsDeVente: 1, anniversaire: false, avisGoogle: false, maxScanners: null },
  pro:     { maxClients: 2000, maxPointsDeVente: 3, anniversaire: true,  avisGoogle: true,  maxScanners: null },
  business: { maxClients: null, maxPointsDeVente: 10, anniversaire: true, avisGoogle: true, maxScanners: null },
  'sur-mesure': { maxClients: 20000, maxPointsDeVente: 10, anniversaire: true, avisGoogle: true, maxScanners: null },
} as const;

export function normalizePlan(plan: string | null | undefined): keyof typeof PLAN_LIMITS {
  const normalized = String(plan ?? 'starter')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');

  if (!normalized) return 'starter';
  if (normalized === 'starter' || normalized.startsWith('starter-') || normalized.includes('starter')) return 'starter';
  if (normalized === 'pro' || normalized.startsWith('pro-') || normalized.includes('pro')) return 'pro';
  if (normalized === 'business' || normalized.startsWith('business-') || normalized.includes('business')) return 'business';
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

async function resolveCoordinates(payload: {
  adresse?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}) {
  if (
    typeof payload.latitude === 'number'
    && Number.isFinite(payload.latitude)
    && typeof payload.longitude === 'number'
    && Number.isFinite(payload.longitude)
  ) {
    return { latitude: payload.latitude, longitude: payload.longitude };
  }

  if (payload.adresse) return geocodeAddress(payload.adresse);
  return null;
}

function applyAddressDetails(target: Record<string, unknown>, source: {
  rue?: string | null;
  ville?: string | null;
  code_postal?: string | null;
  pays?: string | null;
}) {
  if (source.rue !== undefined) target.rue = source.rue;
  if (source.ville !== undefined) target.ville = source.ville;
  if (source.code_postal !== undefined) target.code_postal = source.code_postal;
  if (source.pays !== undefined) target.pays = source.pays;
}

function isMissingAddressDetailsError(error: { message?: string } | null | undefined) {
  return /rue|ville|code_postal|pays|schema cache|does not exist/i.test(error?.message ?? '');
}

function stripAddressDetails<T extends Record<string, unknown>>(payload: T): T {
  const cloned = { ...payload };
  delete cloned.rue;
  delete cloned.ville;
  delete cloned.code_postal;
  delete cloned.pays;
  return cloned;
}

async function getOwnedCommerceForUser(db: SupabaseClient, userId: string) {
  const { data, error } = await db
    .from('commerces')
    .select('id, nom')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data as { id: string; nom: string | null } | null;
}

function serializeMember(member: Record<string, unknown>, currentUserId: string) {
  return {
    id: member.id,
    commerce_id: member.commerce_id,
    user_id: member.user_id,
    email: member.email,
    role: member.role,
    status: member.status,
    created_at: member.created_at,
    updated_at: member.updated_at,
    is_current_user: member.user_id === currentUserId,
  };
}

/** POST /api/commerces/bootstrap — Initialise l'espace commerçant après inscription */
commercesRoutes.post('/bootstrap', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from('commerces')
    .select('id, nom, email, onboarding_completed, billing_status')
    .eq('user_id', userId)
    .maybeSingle();

  if (existingError) {
    console.error('[commerces bootstrap] existing lookup error:', existingError.message);
    return c.json({ error: "Impossible d'initialiser l'espace commerçant." }, 500);
  }

  if (existing) {
    return c.json({
      data: {
        commerce: existing,
        created: false,
        welcome_email: { ok: false, skipped: true, reason: 'existing_commerce' },
        sender: getWelcomeEmailSender(),
      },
    });
  }

  const { data: { user }, error: userError } = await db.auth.admin.getUserById(userId);
  if (userError) {
    console.error('[commerces bootstrap] auth user error:', userError.message);
  }

  const email = user?.email ?? null;
  const commerceName = 'Mon commerce';
  const { data: commerce, error: createError } = await db
    .from('commerces')
    .insert({
      user_id: userId,
      nom: commerceName,
      email,
      onboarding_completed: false,
      billing_status: 'unpaid',
    })
    .select('id, nom, email, onboarding_completed, billing_status')
    .single();

  if (createError || !commerce) {
    console.error('[commerces bootstrap] create error:', createError?.message);
    return c.json({ error: "Impossible de créer l'espace commerçant." }, 500);
  }

  // Crée immédiatement le point de vente principal pour éviter tout état intermédiaire sans point.
  await db.from('points_vente').insert({
    commerce_id: commerce.id,
    nom: commerceName,
    principal: true,
    actif: true,
  }).then(({ error }) => {
    if (error) console.warn('[commerces bootstrap] point de vente creation failed (will be auto-created later):', error.message);
  });

  const welcomeEmail = email
    ? await sendWelcomeEmail({ toEmail: email, commerceName })
    : { ok: false, skipped: true, reason: 'missing_email' as const };

  return c.json({
    data: {
      commerce,
      created: true,
      welcome_email: welcomeEmail,
      sender: getWelcomeEmailSender(),
    },
  }, 201);
});

/** GET /api/commerces/me — Récupère le commerce de l'utilisateur connecté */
commercesRoutes.get('/me', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  try {
    const { commerce, pointVente, pointsVente, access } = await resolveCommerceAndPointVente(
      db,
      userId,
      requestedPointVenteId,
      '*',
    );

    if (!commerce) return c.json({ data: null });

    const mergedCommerce = {
      ...commerce,
      adresse: pointVente?.adresse ?? commerce.adresse ?? null,
      rue: pointVente?.rue ?? null,
      ville: pointVente?.ville ?? null,
      code_postal: pointVente?.code_postal ?? null,
      pays: pointVente?.pays ?? null,
      latitude: pointVente?.latitude ?? commerce.latitude ?? null,
      longitude: pointVente?.longitude ?? commerce.longitude ?? null,
      rayon_geo: pointVente?.rayon_geo ?? commerce.rayon_geo ?? 1000,
      point_vente_id: pointVente?.id ?? null,
      point_vente_nom: pointVente?.nom ?? commerce.nom ?? null,
      points_vente_count: pointsVente.length,
      points_vente: pointsVente,
      access_role: access?.role ?? null,
      is_owner: Boolean(access?.isOwner),
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

  const { data: existingMember, error: existingMemberError } = await db
    .from('commerce_members')
    .select('commerce_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (existingMemberError && !isMissingCommerceMembersTable(existingMemberError)) {
    console.error('[commerces create member check]', existingMemberError);
  }

  if (existingMember?.commerce_id) {
    return c.json({ error: 'Ce compte a déjà accès à un commerce.' }, 409);
  }

  const {
    point_vente_nom: _ignorePointVenteNom,
    rue: _ignoreRue,
    ville: _ignoreVille,
    code_postal: _ignoreCodePostal,
    pays: _ignorePays,
    latitude: _ignoreLatitude,
    longitude: _ignoreLongitude,
    ...commerceInsertPayload
  } = parsed.data;

  const { data, error } = await db
    .from('commerces')
    .insert({ ...commerceInsertPayload, user_id: userId })
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la création' }, 500);

  const coords = await resolveCoordinates(parsed.data);
  const pointInsertPayload: Record<string, unknown> = {
    commerce_id: data.id,
    nom: parsed.data.nom,
    adresse: parsed.data.adresse ?? null,
    rue: parsed.data.rue ?? null,
    ville: parsed.data.ville ?? null,
    code_postal: parsed.data.code_postal ?? null,
    pays: parsed.data.pays ?? null,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    rayon_geo: parsed.data.rayon_geo ?? 1000,
    principal: true,
    actif: true,
  };

  const { error: pointInsertError } = await db
    .from('points_vente')
    .insert(pointInsertPayload);
  if (pointInsertError && isMissingAddressDetailsError(pointInsertError)) {
    await db.from('points_vente').insert(stripAddressDetails(pointInsertPayload));
  }

  return c.json({ data }, 201);
});

/** GET /api/commerces/members — Liste les accès au commerce */
commercesRoutes.get('/members', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  try {
    const ownedCommerce = await getOwnedCommerceForUser(db, userId);
    if (!ownedCommerce) {
      return c.json({ error: 'Seul le propriétaire du commerce peut gérer les accès équipe.' }, 403);
    }

    const { data, error } = await db
      .from('commerce_members')
      .select('id, commerce_id, user_id, email, role, status, created_at, updated_at')
      .eq('commerce_id', ownedCommerce.id)
      .order('role', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      if (isMissingCommerceMembersTable(error)) {
        return c.json({
          error: 'La table des accès équipe n’est pas encore installée.',
          code: 'MEMBERS_TABLE_MISSING',
        }, 503);
      }
      throw error;
    }

    return c.json({
      data: (data ?? []).map((member) => serializeMember(member as Record<string, unknown>, userId)),
    });
  } catch (error) {
    console.error('[commerces members list]', error);
    return c.json({ error: 'Impossible de charger les accès équipe.' }, 500);
  }
});

/** POST /api/commerces/members — Ajoute un accès secondaire */
commercesRoutes.post('/members', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = memberCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const normalizedEmail = normalizeMemberEmail(parsed.data.email);

  try {
    const ownedCommerce = await getOwnedCommerceForUser(db, userId);
    if (!ownedCommerce) {
      return c.json({ error: 'Seul le propriétaire du commerce peut gérer les accès équipe.' }, 403);
    }

    const targetUser = await findAuthUserByEmail(db, normalizedEmail);
    if (!targetUser?.id) {
      return c.json({
        error: "Ce compte n’existe pas encore. Créez d’abord son compte Fidelopass, puis ajoutez-le ici.",
        code: 'AUTH_USER_NOT_FOUND',
      }, 404);
    }

    if (targetUser.id === userId) {
      return c.json({ error: 'Ce compte est déjà le propriétaire du commerce.' }, 409);
    }

    const { data: targetOwnCommerce, error: ownCommerceError } = await db
      .from('commerces')
      .select('id, nom')
      .eq('user_id', targetUser.id)
      .maybeSingle();

    if (ownCommerceError) throw ownCommerceError;
    if (targetOwnCommerce?.id) {
      return c.json({
        error: 'Ce compte possède déjà son propre commerce. Utilisez un compte secondaire sans commerce.',
        code: 'USER_ALREADY_OWNS_COMMERCE',
      }, 409);
    }

    const { data: activeMembership, error: membershipLookupError } = await db
      .from('commerce_members')
      .select('id, commerce_id, status')
      .eq('user_id', targetUser.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    if (membershipLookupError && !isMissingCommerceMembersTable(membershipLookupError)) throw membershipLookupError;
    if (activeMembership?.commerce_id && activeMembership.commerce_id !== ownedCommerce.id) {
      return c.json({
        error: 'Ce compte a déjà accès à un autre commerce.',
        code: 'USER_ALREADY_MEMBER',
      }, 409);
    }

    const { data, error } = await db
      .from('commerce_members')
      .upsert({
        commerce_id: ownedCommerce.id,
        user_id: targetUser.id,
        email: normalizedEmail,
        role: parsed.data.role,
        status: 'active',
        invited_by: userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'commerce_id,user_id' })
      .select('id, commerce_id, user_id, email, role, status, created_at, updated_at')
      .single();

    if (error) {
      if (isMissingCommerceMembersTable(error)) {
        return c.json({
          error: 'La table des accès équipe n’est pas encore installée.',
          code: 'MEMBERS_TABLE_MISSING',
        }, 503);
      }
      if (error.code === '23505') {
        return c.json({ error: 'Cet email a déjà accès à ce commerce.' }, 409);
      }
      throw error;
    }

    return c.json({ data: serializeMember(data as Record<string, unknown>, userId) }, 201);
  } catch (error) {
    console.error('[commerces members create]', error);
    return c.json({ error: 'Impossible d’ajouter cet accès équipe.' }, 500);
  }
});

/** PATCH /api/commerces/members/:id — Modifie role/statut d’un accès */
commercesRoutes.patch('/members/:id', async (c) => {
  const userId = c.get('userId') as string;
  const memberId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = memberUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();

  try {
    const ownedCommerce = await getOwnedCommerceForUser(db, userId);
    if (!ownedCommerce) {
      return c.json({ error: 'Seul le propriétaire du commerce peut gérer les accès équipe.' }, 403);
    }

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.role !== undefined) payload.role = parsed.data.role;
    if (parsed.data.status !== undefined) payload.status = parsed.data.status;

    if (Object.keys(payload).length <= 1) {
      return c.json({ error: 'Aucune modification fournie.' }, 400);
    }

    const { data: member, error: memberError } = await db
      .from('commerce_members')
      .select('id, role, user_id')
      .eq('id', memberId)
      .eq('commerce_id', ownedCommerce.id)
      .single();

    if (memberError || !member) return c.json({ error: 'Accès introuvable.' }, 404);
    if (member.role === 'owner' || member.user_id === userId) {
      return c.json({ error: 'Le propriétaire ne peut pas être modifié ici.' }, 400);
    }

    const { data, error } = await db
      .from('commerce_members')
      .update(payload)
      .eq('id', memberId)
      .eq('commerce_id', ownedCommerce.id)
      .neq('role', 'owner')
      .select('id, commerce_id, user_id, email, role, status, created_at, updated_at')
      .single();

    if (error) throw error;
    return c.json({ data: serializeMember(data as Record<string, unknown>, userId) });
  } catch (error) {
    console.error('[commerces members update]', error);
    return c.json({ error: 'Impossible de modifier cet accès équipe.' }, 500);
  }
});

/** DELETE /api/commerces/members/:id — Retire un accès secondaire */
commercesRoutes.delete('/members/:id', async (c) => {
  const userId = c.get('userId') as string;
  const memberId = c.req.param('id');
  const db = createServiceClient();

  try {
    const ownedCommerce = await getOwnedCommerceForUser(db, userId);
    if (!ownedCommerce) {
      return c.json({ error: 'Seul le propriétaire du commerce peut gérer les accès équipe.' }, 403);
    }

    const { data: member, error: memberError } = await db
      .from('commerce_members')
      .select('id, role, user_id')
      .eq('id', memberId)
      .eq('commerce_id', ownedCommerce.id)
      .single();

    if (memberError || !member) return c.json({ error: 'Accès introuvable.' }, 404);
    if (member.role === 'owner' || member.user_id === userId) {
      return c.json({ error: 'Le propriétaire ne peut pas être supprimé ici.' }, 400);
    }

    const { error } = await db
      .from('commerce_members')
      .delete()
      .eq('id', memberId)
      .eq('commerce_id', ownedCommerce.id)
      .neq('role', 'owner');

    if (error) throw error;
    return c.json({ ok: true });
  } catch (error) {
    console.error('[commerces members delete]', error);
    return c.json({ error: 'Impossible de retirer cet accès équipe.' }, 500);
  }
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
  if (
    parsed.data.nom !== undefined
    && parsed.data.point_vente_nom === undefined
    && pointVente.principal
    && commerce.onboarding_completed !== true
  ) {
    pointPayload.nom = parsed.data.nom;
  }
  if (parsed.data.adresse !== undefined) pointPayload.adresse = parsed.data.adresse;
  if (parsed.data.rayon_geo !== undefined) pointPayload.rayon_geo = parsed.data.rayon_geo;
  applyAddressDetails(pointPayload, parsed.data);

  if (parsed.data.latitude !== undefined) pointPayload.latitude = parsed.data.latitude;
  if (parsed.data.longitude !== undefined) pointPayload.longitude = parsed.data.longitude;

  if (parsed.data.adresse !== undefined || parsed.data.latitude !== undefined || parsed.data.longitude !== undefined) {
    const coords = await resolveCoordinates(parsed.data);
    if (coords) {
      pointPayload.latitude = coords.latitude;
      pointPayload.longitude = coords.longitude;
      commercePayload.latitude = coords.latitude;
      commercePayload.longitude = coords.longitude;
    }
    if (parsed.data.adresse !== undefined) commercePayload.adresse = parsed.data.adresse;
  }

  if (Object.keys(commercePayload).length > 1) {
    const { error: commerceError } = await db
      .from('commerces')
      .update(commercePayload)
      .eq('id', commerce.id);
    if (commerceError) return c.json({ error: 'Erreur lors de la mise à jour du commerce' }, 500);
  }

  if (Object.keys(pointPayload).length > 1) {
    let pointUpdatePayload = pointPayload;
    let { error: pointError } = await db
      .from('points_vente')
      .update(pointUpdatePayload)
      .eq('id', pointVente.id)
      .eq('commerce_id', commerce.id);
    if (pointError && isMissingAddressDetailsError(pointError)) {
      pointUpdatePayload = stripAddressDetails(pointPayload);
      const retry = await db
        .from('points_vente')
        .update(pointUpdatePayload)
        .eq('id', pointVente.id)
        .eq('commerce_id', commerce.id);
      pointError = retry.error;
    }
    if (pointError) return c.json({ error: 'Erreur lors de la mise à jour du point de vente' }, 500);
  }

  let { data: updatedPoint, error: updatedPointError } = await db
    .from('points_vente')
    .select('id, commerce_id, nom, adresse, rue, ville, code_postal, pays, latitude, longitude, rayon_geo, principal, actif, created_at')
    .eq('id', pointVente.id)
    .single();
  if (updatedPointError && isMissingAddressDetailsError(updatedPointError)) {
    const retry = await db
      .from('points_vente')
      .select('id, commerce_id, nom, adresse, latitude, longitude, rayon_geo, principal, actif, created_at')
      .eq('id', pointVente.id)
      .single();
    updatedPoint = retry.data as typeof updatedPoint;
  }

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
      rue: updatedPoint?.rue ?? parsed.data.rue ?? null,
      ville: updatedPoint?.ville ?? parsed.data.ville ?? null,
      code_postal: updatedPoint?.code_postal ?? parsed.data.code_postal ?? null,
      pays: updatedPoint?.pays ?? parsed.data.pays ?? null,
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

/** POST /api/commerces/me/wallet-sync — Force la mise à jour Wallet du point de vente actif */
commercesRoutes.post('/me/wallet-sync', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan, plan_override',
  );

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);
  if (!pointVente) return c.json({ error: 'Point de vente introuvable' }, 404);

  const stats = await syncWalletForPointVente(pointVente.id);
  return c.json({
    ok: true,
    data: {
      point_vente_id: pointVente.id,
      ...stats,
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
    'id, plan, plan_override',
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
    'id, plan, plan_override',
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

  const coords = await resolveCoordinates(parsed.data);
  const pointInsertPayload: Record<string, unknown> = {
    commerce_id: commerce.id,
    nom: parsed.data.nom,
    adresse: parsed.data.adresse ?? null,
    rue: parsed.data.rue ?? null,
    ville: parsed.data.ville ?? null,
    code_postal: parsed.data.code_postal ?? null,
    pays: parsed.data.pays ?? null,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    rayon_geo: parsed.data.rayon_geo ?? 1000,
    principal: pointsVente.length === 0,
    actif: true,
  };
  let { data, error } = await db
    .from('points_vente')
    .insert(pointInsertPayload)
    .select()
    .single();
  if (error && isMissingAddressDetailsError(error)) {
    const retry = await db
      .from('points_vente')
      .insert(stripAddressDetails(pointInsertPayload))
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

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
  const { commerce } = await resolveCommerceAndPointVente(db, userId, null, 'id, plan, plan_override');
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
  applyAddressDetails(payload, parsed.data);
  if (parsed.data.latitude !== undefined) payload.latitude = parsed.data.latitude;
  if (parsed.data.longitude !== undefined) payload.longitude = parsed.data.longitude;

  if (parsed.data.adresse !== undefined || parsed.data.latitude !== undefined || parsed.data.longitude !== undefined) {
    const coords = await resolveCoordinates(parsed.data);
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

  let { data, error } = await db
    .from('points_vente')
    .update(payload)
    .eq('id', pointVenteId)
    .eq('commerce_id', commerce.id)
    .select()
    .single();
  if (error && isMissingAddressDetailsError(error)) {
    const retry = await db
      .from('points_vente')
      .update(stripAddressDetails(payload))
      .eq('id', pointVenteId)
      .eq('commerce_id', commerce.id)
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    if (error.code === '23505') {
      return c.json({
        error: 'Un autre point de vente est déjà principal. Rechargez la page puis réessayez.',
      }, 409);
    }
    return c.json({ error: 'Erreur lors de la mise à jour du point de vente.' }, 500);
  }
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
