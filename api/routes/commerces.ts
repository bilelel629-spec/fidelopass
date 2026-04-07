import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { geocodeAddress } from '../services/geocoding';

export const commercesRoutes = new Hono();

commercesRoutes.use('*', authMiddleware);

const updateSchema = z.object({
  nom: z.string().min(2).max(255).optional(),
  adresse: z.string().max(500).nullable().optional(),
  telephone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  logo_url: z.string().url().nullable().optional(),
  rayon_geo: z.number().int().min(100).max(50000).optional(),
});

/** GET /api/commerces/me — Récupère le commerce de l'utilisateur connecté */
commercesRoutes.get('/me', async (c) => {
  const userId = c.get('userId') as string;
  const db = createServiceClient();

  const { data, error } = await db
    .from('commerces')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    return c.json({ error: 'Erreur lors de la récupération du commerce' }, 500);
  }

  return c.json({ data: data ?? null });
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

  const { data, error } = await db
    .from('commerces')
    .insert({ ...parsed.data, user_id: userId })
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la création' }, 500);

  return c.json({ data }, 201);
});

/** PATCH /api/commerces/me — Met à jour le commerce + géocode l'adresse si modifiée */
commercesRoutes.patch('/me', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const db = createServiceClient();

  // Géocodage automatique si l'adresse a changé
  const updatePayload: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

  if (parsed.data.adresse) {
    const coords = await geocodeAddress(parsed.data.adresse);
    if (coords) {
      updatePayload.latitude = coords.latitude;
      updatePayload.longitude = coords.longitude;
    }
  }

  const { data, error } = await db
    .from('commerces')
    .update(updatePayload)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) return c.json({ error: 'Erreur lors de la mise à jour' }, 500);

  return c.json({ data });
});

