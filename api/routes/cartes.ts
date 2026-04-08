import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';

export const cartesRoutes = new Hono();

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
  strip_position: z.enum(['top', 'center', 'bottom']).default('center'),
  tampon_icon_url: z.string().url().nullable().optional(),
  barcode_type: z.enum(['QR', 'PDF417', 'AZTEC', 'CODE128', 'NONE']).default('QR'),
  label_client: z.string().max(50).default('Client'),
  // Champs avancés (migration 003)
  couleur_fond_2: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  gradient_angle: z.number().int().min(0).max(360).default(135),
  pattern_type: z.enum(['none', 'dots', 'waves', 'grid', 'diagonal', 'confetti']).default('none'),
  tampon_emoji: z.string().max(8).nullable().optional(),
  // Typographie (migration 004)
  police: z.enum(['system', 'inter', 'playfair', 'bebas', 'nunito', 'mono']).default('system'),
  police_taille: z.number().int().min(70).max(150).default(100),
  police_gras: z.boolean().default(false),
  texte_alignement: z.enum(['left', 'center', 'right']).default('left'),
  strip_plein_largeur: z.boolean().default(false),
});

/** GET /api/cartes — Récupère la carte du commerce connecté */
cartesRoutes.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ data: null });

  const { data } = await db
    .from('cartes')
    .select('*')
    .eq('commerce_id', commerce.id)
    .single();

  return c.json({ data: data ?? null });
});

/** GET /api/cartes/:id/public — Infos publiques pour la page d'ajout au Wallet */
cartesRoutes.get('/:id/public', async (c) => {
  const carteId = c.req.param('id');
  const db = createServiceClient();

  const { data: carte } = await db
    .from('cartes')
    .select('*, commerces(id, nom, logo_url)')
    .eq('id', carteId)
    .eq('actif', true)
    .single();

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  const { commerces, ...carteData } = carte as typeof carte & { commerces: { id: string; nom: string; logo_url: string | null } };

  return c.json({
    data: {
      carte: carteData,
      commerce: commerces,
    },
  });
});

/** POST /api/cartes — Crée une carte */
cartesRoutes.post('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = carteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Créez d\'abord votre commerce' }, 400);

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

  const advFields: Record<string, unknown> = {};
  if (parsed.data.couleur_fond_2 !== undefined) advFields.couleur_fond_2 = parsed.data.couleur_fond_2;
  if (parsed.data.gradient_angle !== undefined) advFields.gradient_angle = parsed.data.gradient_angle;
  if (parsed.data.pattern_type !== undefined) advFields.pattern_type = parsed.data.pattern_type;
  if (parsed.data.tampon_emoji !== undefined) advFields.tampon_emoji = parsed.data.tampon_emoji;

  const typoFields: Record<string, unknown> = {};
  if (parsed.data.police !== undefined) typoFields.police = parsed.data.police;
  if (parsed.data.police_taille !== undefined) typoFields.police_taille = parsed.data.police_taille;
  if (parsed.data.police_gras !== undefined) typoFields.police_gras = parsed.data.police_gras;
  if (parsed.data.texte_alignement !== undefined) typoFields.texte_alignement = parsed.data.texte_alignement;
  if (parsed.data.strip_plein_largeur !== undefined) typoFields.strip_plein_largeur = parsed.data.strip_plein_largeur;

  // Essai 1 : tout (base + ext + adv + typo)
  let result = await db
    .from('cartes')
    .upsert({ ...baseFields, ...extFields, ...advFields, ...typoFields }, { onConflict: 'commerce_id' })
    .select()
    .single();

  if (result.error?.message?.includes('column')) {
    // Essai 2 : base + ext + adv (migration 004 pas encore exécutée)
    result = await db
      .from('cartes')
      .upsert({ ...baseFields, ...extFields, ...advFields }, { onConflict: 'commerce_id' })
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 3 : base + ext (migration 003 non plus)
    result = await db
      .from('cartes')
      .upsert({ ...baseFields, ...extFields }, { onConflict: 'commerce_id' })
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 4 : base only
    result = await db
      .from('cartes')
      .upsert(baseFields, { onConflict: 'commerce_id' })
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
cartesRoutes.patch('/:id', authMiddleware, async (c) => {
  const carteId = c.req.param('id');
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = carteSchema.partial().safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();
  const { data: commerce } = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!commerce) return c.json({ error: 'Commerce introuvable' }, 404);

  const {
    logo_url, strip_url, strip_position, tampon_icon_url, barcode_type, label_client,
    couleur_fond_2, gradient_angle, pattern_type, tampon_emoji,
    police, police_taille, police_gras, texte_alignement, strip_plein_largeur,
    ...baseData
  } = parsed.data;

  const extFields: Record<string, unknown> = {};
  if (logo_url !== undefined) extFields.logo_url = logo_url;
  if (strip_url !== undefined) extFields.strip_url = strip_url;
  if (strip_position !== undefined) extFields.strip_position = strip_position;
  if (tampon_icon_url !== undefined) extFields.tampon_icon_url = tampon_icon_url;
  if (barcode_type !== undefined) extFields.barcode_type = barcode_type;
  if (label_client !== undefined) extFields.label_client = label_client;

  const advFields: Record<string, unknown> = {};
  if (couleur_fond_2 !== undefined) advFields.couleur_fond_2 = couleur_fond_2;
  if (gradient_angle !== undefined) advFields.gradient_angle = gradient_angle;
  if (pattern_type !== undefined) advFields.pattern_type = pattern_type;
  if (tampon_emoji !== undefined) advFields.tampon_emoji = tampon_emoji;

  const typoFields: Record<string, unknown> = {};
  if (police !== undefined) typoFields.police = police;
  if (police_taille !== undefined) typoFields.police_taille = police_taille;
  if (police_gras !== undefined) typoFields.police_gras = police_gras;
  if (texte_alignement !== undefined) typoFields.texte_alignement = texte_alignement;
  if (strip_plein_largeur !== undefined) typoFields.strip_plein_largeur = strip_plein_largeur;

  const ts = { updated_at: new Date().toISOString() };

  // Essai 1 : tout
  let result = await db
    .from('cartes')
    .update({ ...baseData, ...extFields, ...advFields, ...typoFields, ...ts })
    .eq('id', carteId)
    .eq('commerce_id', commerce.id)
    .select()
    .single();

  if (result.error?.message?.includes('column')) {
    // Essai 2 : sans typo (migration 004 manquante)
    result = await db
      .from('cartes')
      .update({ ...baseData, ...extFields, ...advFields, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 3 : base + ext
    result = await db
      .from('cartes')
      .update({ ...baseData, ...extFields, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .select()
      .single();
  }

  if (result.error?.message?.includes('column')) {
    // Essai 4 : base only
    result = await db
      .from('cartes')
      .update({ ...baseData, ...ts })
      .eq('id', carteId)
      .eq('commerce_id', commerce.id)
      .select()
      .single();
  }

  if (result.error) {
    console.error('[cartes PATCH]', result.error);
    return c.json({ error: result.error.message }, 500);
  }

  return c.json({ data: result.data });
});
