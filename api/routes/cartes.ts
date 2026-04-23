import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { getPlanLimits } from './commerces';
import { pushApplePassUpdate } from '../services/apple-wallet';
import { upsertLoyaltyClass, updateGooglePassObject } from '../services/google-wallet';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

export const cartesRoutes = new Hono();

function withEffectiveCommerceLogo<
  T extends {
    logo_url?: string | null;
    commerces?: { logo_url?: string | null; nom?: string | null } | null;
    points_vente?: { nom?: string | null } | null;
  },
>(carte: T): T {
  if (carte?.commerces) {
    carte.commerces.logo_url = carte.logo_url ?? carte.commerces.logo_url ?? null;
    if (carte.points_vente?.nom) {
      carte.commerces.nom = carte.points_vente.nom;
    }
  }
  return carte;
}

const rewardSchema = z.object({
  seuil: z.number().int().min(1).max(100000),
  recompense: z.string().min(1).max(120),
});

const vipTierSchema = z.object({
  nom: z.string().min(1).max(24),
  seuil: z.number().int().min(1).max(100000),
  avantage: z.string().max(120).optional().default(''),
});

const stripPositionSchema = z.string().default('50:50').refine((value) => {
  const normalized = value.trim().toLowerCase();
  if (['top', 'center', 'bottom'].includes(normalized)) return true;
  const match = normalized.match(/^(\d{1,3}(?:\.\d+)?):(\d{1,3}(?:\.\d+)?)$/);
  if (!match) return false;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
}, { message: 'Position de bannière invalide' });

const carteSchema = z.object({
  nom: z.string().min(2).max(255),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(['points', 'tampons']),
  tampons_total: z.number().int().min(1).max(50).default(10),
  points_par_euro: z.number().min(0.1).max(100).default(1),
  points_recompense: z.number().int().min(1).default(100),
  recompense_description: z.string().max(255).nullable().optional(),
  couleur_fond: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#1a1a2e'),
  couleur_texte: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#ffffff'),
  couleur_accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#e94560'),
  message_geo: z.string().max(255).optional(),
  // Champs étendus (migration 002)
  logo_url: z.string().url().nullable().optional(),
  strip_url: z.string().url().nullable().optional(),
  strip_position: stripPositionSchema,
  tampon_icon_url: z.string().url().nullable().optional(),
  barcode_type: z.enum(['QR', 'PDF417', 'AZTEC', 'CODE128', 'NONE']).default('QR'),
  label_client: z.string().max(50).default('Client'),
  push_icon_bg_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366f1'),
  // Champs avancés (migration 003)
  couleur_fond_2: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  gradient_angle: z.number().int().min(0).max(360).default(135),
  pattern_type: z.enum(['none', 'dots', 'waves', 'grid', 'diagonal', 'confetti']).default('none'),
  tampon_emoji: z.string().max(8).nullable().optional(),
  tampon_icon_scale: z.number().min(0.6).max(1.5).default(1),
  // Compatibilité ancienne migration : les Wallets gardent leur typographie native.
  police: z.enum(['system', 'inter', 'playfair', 'bebas', 'nunito', 'mono']).default('system'),
  police_taille: z.number().int().min(70).max(150).default(100),
  police_gras: z.boolean().default(false),
  texte_alignement: z.enum(['left', 'center', 'right']).default('left'),
  strip_plein_largeur: z.boolean().default(true),
  banner_overlay_opacity: z.number().int().min(0).max(85).default(0),
  // Personnalisation programme (migration 006)
  welcome_message: z.string().max(180).nullable().optional(),
  success_message: z.string().max(180).nullable().optional(),
  rewards_config: z.array(rewardSchema).max(6).default([]),
  rewards_multi_enabled: z.boolean().default(false),
  vip_tiers: z.array(vipTierSchema).max(3).default([]),
  strip_layout: z.enum(['background', 'top', 'bottom']).default('background'),
  branding_powered_by_enabled: z.boolean().default(true),
  // Récompense avis Google (migration 007)
  review_reward_enabled: z.boolean().default(false),
  review_reward_value: z.number().int().min(1).max(50).default(1),
  google_maps_url: z.string().url().nullable().optional(),
  // Programmation anniversaire (migration 014)
  birthday_auto_enabled: z.boolean().default(false),
  birthday_reward_value: z.number().int().min(1).max(50).default(1),
  birthday_push_title: z.string().max(80).nullable().optional(),
  birthday_push_message: z.string().max(180).nullable().optional(),
});

/** GET /api/cartes — Récupère la carte du commerce connecté */
cartesRoutes.get('/', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ data: null });

  const { data } = await db
    .from('cartes')
    .select('*')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('actif', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return c.json({ data: data ?? null });
});

/** GET /api/cartes/active — carte active du point de vente courant */
cartesRoutes.get('/active', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();
  const requestedPointVenteId = readRequestedPointVenteId(c);

  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ data: null });

  const { data } = await db
    .from('cartes')
    .select('id, nom, point_vente_id, updated_at, actif')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('actif', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return c.json({ data: data ?? null });
});

/** GET /api/cartes/:id/public — Infos publiques pour la page d'ajout au Wallet */
cartesRoutes.get('/:id/public', async (c) => {
  const carteId = c.req.param('id');
  const db = createServiceClient();

  const { data: carte } = await db
    .from('cartes')
    .select('*, commerces(id, nom, logo_url), points_vente(id, nom, adresse, latitude, longitude, rayon_geo)')
    .eq('id', carteId)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  withEffectiveCommerceLogo(carte);

  const {
    commerces,
    points_vente: pointVente,
    ...carteData
  } = carte as typeof carte & {
    commerces: { id: string; nom: string; logo_url: string | null };
    points_vente: { id: string; nom: string; adresse: string | null; latitude: number | null; longitude: number | null; rayon_geo: number | null } | null;
  };

  return c.json({
    data: {
      carte: carteData,
      commerce: {
        ...commerces,
        nom: pointVente?.nom ?? commerces.nom,
      },
      point_vente: pointVente ?? null,
    },
  });
});

/** POST /api/cartes — Crée une carte */
cartesRoutes.post('/', authMiddleware, paidMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = carteSchema.safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Créez d\'abord votre point de vente' }, 400);

  const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';

  const baseFields = {
    nom: parsed.data.nom,
    description: parsed.data.description,
    type: parsed.data.type,
    tampons_total: parsed.data.tampons_total,
    points_par_euro: parsed.data.points_par_euro,
    points_recompense: parsed.data.points_recompense,
    recompense_description: parsed.data.recompense_description,
    couleur_fond: parsed.data.couleur_fond,
    couleur_texte: parsed.data.couleur_texte,
    couleur_accent: parsed.data.couleur_accent,
    message_geo: parsed.data.message_geo,
    commerce_id: commerce.id,
    point_vente_id: pointVente.id,
    pass_type_id: passTypeId,
    updated_at: new Date().toISOString(),
  };

  const extFields: Record<string, unknown> = {};
  if (parsed.data.logo_url !== undefined) extFields.logo_url = parsed.data.logo_url;
  if (parsed.data.strip_url !== undefined) extFields.strip_url = parsed.data.strip_url;
  if (parsed.data.strip_position !== undefined) extFields.strip_position = parsed.data.strip_position;
  if (parsed.data.tampon_icon_url !== undefined) extFields.tampon_icon_url = parsed.data.tampon_icon_url;
  if (parsed.data.barcode_type !== undefined) extFields.barcode_type = parsed.data.barcode_type;
  if (parsed.data.label_client !== undefined) extFields.label_client = parsed.data.label_client;
  if (parsed.data.push_icon_bg_color !== undefined) extFields.push_icon_bg_color = parsed.data.push_icon_bg_color;

  const advFields: Record<string, unknown> = {};
  if (parsed.data.couleur_fond_2 !== undefined) advFields.couleur_fond_2 = parsed.data.couleur_fond_2;
  if (parsed.data.gradient_angle !== undefined) advFields.gradient_angle = parsed.data.gradient_angle;
  if (parsed.data.pattern_type !== undefined) advFields.pattern_type = parsed.data.pattern_type;
  if (parsed.data.tampon_emoji !== undefined) advFields.tampon_emoji = parsed.data.tampon_emoji;
  if (parsed.data.tampon_icon_scale !== undefined) advFields.tampon_icon_scale = parsed.data.tampon_icon_scale;

  const typoFields: Record<string, unknown> = {};
  if (parsed.data.police !== undefined) typoFields.police = parsed.data.police;
  if (parsed.data.police_taille !== undefined) typoFields.police_taille = parsed.data.police_taille;
  if (parsed.data.police_gras !== undefined) typoFields.police_gras = parsed.data.police_gras;
  if (parsed.data.texte_alignement !== undefined) typoFields.texte_alignement = parsed.data.texte_alignement;
  if (parsed.data.strip_plein_largeur !== undefined) typoFields.strip_plein_largeur = parsed.data.strip_plein_largeur;
  if (parsed.data.banner_overlay_opacity !== undefined) typoFields.banner_overlay_opacity = parsed.data.banner_overlay_opacity;

  const programFields: Record<string, unknown> = {};
  if (parsed.data.welcome_message !== undefined) programFields.welcome_message = parsed.data.welcome_message;
  if (parsed.data.success_message !== undefined) programFields.success_message = parsed.data.success_message;
  if (parsed.data.rewards_multi_enabled !== undefined) programFields.rewards_multi_enabled = parsed.data.rewards_multi_enabled;
  if (parsed.data.rewards_config !== undefined) {
    programFields.rewards_config = parsed.data.rewards_multi_enabled ? parsed.data.rewards_config : [];
  }
  if (parsed.data.vip_tiers !== undefined) programFields.vip_tiers = parsed.data.vip_tiers;
  if (parsed.data.strip_layout !== undefined) programFields.strip_layout = parsed.data.strip_layout;
  if (parsed.data.branding_powered_by_enabled !== undefined) {
    const planLimits = getPlanLimits(getEffectivePlanRaw(commerce));
    programFields.branding_powered_by_enabled = planLimits.avisGoogle
      ? parsed.data.branding_powered_by_enabled
      : true;
  }
  if (parsed.data.review_reward_enabled !== undefined) programFields.review_reward_enabled = parsed.data.review_reward_enabled;
  if (parsed.data.review_reward_value !== undefined) programFields.review_reward_value = parsed.data.review_reward_value;
  if (parsed.data.google_maps_url !== undefined) programFields.google_maps_url = parsed.data.google_maps_url;
  if (parsed.data.birthday_auto_enabled !== undefined) programFields.birthday_auto_enabled = parsed.data.birthday_auto_enabled;
  if (parsed.data.birthday_reward_value !== undefined) programFields.birthday_reward_value = parsed.data.birthday_reward_value;
  if (parsed.data.birthday_push_title !== undefined) programFields.birthday_push_title = parsed.data.birthday_push_title;
  if (parsed.data.birthday_push_message !== undefined) programFields.birthday_push_message = parsed.data.birthday_push_message;

  // Essai 1 : tout (base + ext + adv + typo + programme)
  let result = await db
    .from('cartes')
    .upsert({ ...baseFields, ...extFields, ...advFields, ...typoFields, ...programFields }, { onConflict: 'point_vente_id' })
    .select()
    .single();

  if (result.error?.message?.includes('column')) {
    // Essai 2 : sans migration 006
    result = await db
      .from('cartes')
      .upsert({ ...baseFields, ...extFields, ...advFields, ...typoFields }, { onConflict: 'point_vente_id' })
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 3 : base + ext + adv (migration 004 pas encore exécutée)
    result = await db
      .from('cartes')
      .upsert({ ...baseFields, ...extFields, ...advFields }, { onConflict: 'point_vente_id' })
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 4 : base + ext (migration 003 non plus)
    result = await db
      .from('cartes')
      .upsert({ ...baseFields, ...extFields }, { onConflict: 'point_vente_id' })
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 5 : base only
    result = await db
      .from('cartes')
      .upsert(baseFields, { onConflict: 'point_vente_id' })
      .select()
      .single();
  }

  if (result.error) {
    console.error('[cartes POST]', result.error);
    return c.json({ error: result.error.message }, 500);
  }

  return c.json({ data: result.data }, 201);
});

/** PATCH /api/cartes/:id — Met à jour une carte */
cartesRoutes.patch('/:id', authMiddleware, paidMiddleware, async (c) => {
  const carteId = c.req.param('id');
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = carteSchema.partial().safeParse(body);
  const requestedPointVenteId = readRequestedPointVenteId(c);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
  );

  if (!commerce || !pointVente) return c.json({ error: 'Point de vente introuvable' }, 404);

  const {
    logo_url, strip_url, strip_position, tampon_icon_url, barcode_type, label_client, push_icon_bg_color,
    couleur_fond_2, gradient_angle, pattern_type, tampon_emoji, tampon_icon_scale,
    police, police_taille, police_gras, texte_alignement, strip_plein_largeur, banner_overlay_opacity,
    welcome_message, success_message, rewards_config, rewards_multi_enabled, vip_tiers, strip_layout, branding_powered_by_enabled,
    birthday_auto_enabled, birthday_reward_value, birthday_push_title, birthday_push_message,
    ...baseData
  } = parsed.data;

  const extFields: Record<string, unknown> = {};
  if (logo_url !== undefined) extFields.logo_url = logo_url;
  if (strip_url !== undefined) extFields.strip_url = strip_url;
  if (strip_position !== undefined) extFields.strip_position = strip_position;
  if (tampon_icon_url !== undefined) extFields.tampon_icon_url = tampon_icon_url;
  if (barcode_type !== undefined) extFields.barcode_type = barcode_type;
  if (label_client !== undefined) extFields.label_client = label_client;
  if (push_icon_bg_color !== undefined) extFields.push_icon_bg_color = push_icon_bg_color;

  const advFields: Record<string, unknown> = {};
  if (couleur_fond_2 !== undefined) advFields.couleur_fond_2 = couleur_fond_2;
  if (gradient_angle !== undefined) advFields.gradient_angle = gradient_angle;
  if (pattern_type !== undefined) advFields.pattern_type = pattern_type;
  if (tampon_emoji !== undefined) advFields.tampon_emoji = tampon_emoji;
  if (tampon_icon_scale !== undefined) advFields.tampon_icon_scale = tampon_icon_scale;

  const typoFields: Record<string, unknown> = {};
  if (police !== undefined) typoFields.police = police;
  if (police_taille !== undefined) typoFields.police_taille = police_taille;
  if (police_gras !== undefined) typoFields.police_gras = police_gras;
  if (texte_alignement !== undefined) typoFields.texte_alignement = texte_alignement;
  if (strip_plein_largeur !== undefined) typoFields.strip_plein_largeur = strip_plein_largeur;
  if (banner_overlay_opacity !== undefined) typoFields.banner_overlay_opacity = banner_overlay_opacity;

  const programFields: Record<string, unknown> = {};
  if (welcome_message !== undefined) programFields.welcome_message = welcome_message;
  if (success_message !== undefined) programFields.success_message = success_message;
  if (rewards_multi_enabled !== undefined) programFields.rewards_multi_enabled = rewards_multi_enabled;
  if (rewards_config !== undefined || rewards_multi_enabled === false) {
    programFields.rewards_config = rewards_multi_enabled === false ? [] : rewards_config;
  }
  if (vip_tiers !== undefined) programFields.vip_tiers = vip_tiers;
  if (strip_layout !== undefined) programFields.strip_layout = strip_layout;
  if (branding_powered_by_enabled !== undefined) {
    const planLimits = getPlanLimits(getEffectivePlanRaw(commerce));
    programFields.branding_powered_by_enabled = planLimits.avisGoogle ? branding_powered_by_enabled : true;
  }
  if (parsed.data.review_reward_enabled !== undefined) programFields.review_reward_enabled = parsed.data.review_reward_enabled;
  if (parsed.data.review_reward_value !== undefined) programFields.review_reward_value = parsed.data.review_reward_value;
  if (parsed.data.google_maps_url !== undefined) programFields.google_maps_url = parsed.data.google_maps_url;
  if (birthday_auto_enabled !== undefined) programFields.birthday_auto_enabled = birthday_auto_enabled;
  if (birthday_reward_value !== undefined) programFields.birthday_reward_value = birthday_reward_value;
  if (birthday_push_title !== undefined) programFields.birthday_push_title = birthday_push_title;
  if (birthday_push_message !== undefined) programFields.birthday_push_message = birthday_push_message;

  const ts = { updated_at: new Date().toISOString() };

  // Essai 1 : tout
  let result = await db
    .from('cartes')
    .update({ ...baseData, ...extFields, ...advFields, ...typoFields, ...programFields, ...ts })
    .eq('id', carteId)
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .select()
    .single();

  if (result.error?.message?.includes('column')) {
    // Essai 2 : sans migration 006
    result = await db
      .from('cartes')
      .update({ ...baseData, ...extFields, ...advFields, ...typoFields, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 3 : sans typo (migration 004 manquante)
    result = await db
      .from('cartes')
      .update({ ...baseData, ...extFields, ...advFields, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 4 : base + ext
    result = await db
      .from('cartes')
      .update({ ...baseData, ...extFields, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 5 : base only
    result = await db
      .from('cartes')
      .update({ ...baseData, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .select()
      .single();
  }

  if (result.error) {
    console.error('[cartes PATCH]', result.error);
    return c.json({ error: result.error.message }, 500);
  }

  // Synchronisation Wallet des clients déjà inscrits
  try {
    const updatedCarte = result.data;
    if (!updatedCarte) return c.json({ data: result.data });

    const { data: commerceData, error: commerceError } = await db
      .from('commerces')
      .select('nom, logo_url, plan')
      .eq('id', commerce.id)
      .single();

    if (commerceError || !commerceData) {
      console.error('[cartes PATCH wallet commerce]', commerceError);
      return c.json({ data: result.data });
    }

    const { data: pointVenteData } = await db
      .from('points_vente')
      .select('nom, latitude, longitude, rayon_geo')
      .eq('id', (updatedCarte as { point_vente_id?: string | null }).point_vente_id ?? '')
      .maybeSingle();

    const carteForWallet = {
      ...(updatedCarte as Record<string, unknown>),
      commerces: {
        nom: pointVenteData?.nom ?? commerceData.nom ?? '',
        logo_url: commerceData.logo_url ?? null,
        latitude: pointVenteData?.latitude ?? null,
        longitude: pointVenteData?.longitude ?? null,
        rayon_geo: pointVenteData?.rayon_geo ?? null,
        plan: commerceData.plan ?? 'starter',
      },
    } as Parameters<typeof updateGooglePassObject>[1];

    const { data: clients, error: clientsError } = await db
      .from('clients')
      .select('id, nom, points_actuels, tampons_actuels, recompenses_obtenues, google_pass_id, apple_pass_serial')
      .eq('carte_id', carteId);

    if (clientsError) {
      console.error('[cartes PATCH wallet clients]', clientsError);
      return c.json({ data: result.data });
    }

    const walletClients = clients ?? [];
    if (walletClients.length === 0) return c.json({ data: result.data });

    const googleClients = walletClients.filter((client) => !!client.google_pass_id);
    const appleClients = walletClients.filter((client) => !!client.apple_pass_serial);

    if (googleClients.length > 0) {
      await upsertLoyaltyClass(carteForWallet).catch((err) => {
        console.error('[cartes PATCH wallet google class]', err);
      });

      await Promise.allSettled(
        googleClients.map((client) =>
          updateGooglePassObject(client.google_pass_id as string, carteForWallet, {
            id: client.id,
            nom: client.nom ?? null,
            points_actuels: client.points_actuels,
            tampons_actuels: client.tampons_actuels,
            recompenses_obtenues: client.recompenses_obtenues ?? 0,
          }),
        ),
      );
    }

    if (appleClients.length > 0) {
      const { data: registrations, error: registrationsError } = await db
        .from('apple_pass_registrations')
        .select('client_id, push_token, pass_type_identifier')
        .in('client_id', appleClients.map((client) => client.id));

      if (registrationsError) {
        console.error('[cartes PATCH wallet apple registrations]', registrationsError);
        return c.json({ data: result.data });
      }

      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      await Promise.allSettled(
        uniqueRegistrations.map((registration) =>
          pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
        ),
      );
    }
  } catch (err) {
    console.error('[cartes PATCH wallet-sync]', err);
  }

  return c.json({ data: result.data });
});
