import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';
import { getEffectivePlanRaw } from '../utils/effective-plan';

export const scannersRoutes = new Hono<ApiEnv>();

scannersRoutes.use('*', authMiddleware, paidMiddleware);

const registerScannerSchema = z.object({
  scanner_token: z.string().min(16).max(128),
  device_name: z.string().max(120).optional().nullable(),
});

async function loadCommerceForUser(userId: string, requestedPointVenteId: string | null) {
  const db = createServiceClient();
  const { commerce, pointVente } = await resolveCommerceAndPointVente(
    db,
    userId,
    requestedPointVenteId,
    'id, plan',
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

/** GET /api/scanners/status */
scannersRoutes.get('/status', async (c) => {
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
    if (tokens.includes(scannerToken)) {
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

/** POST /api/scanners/register */
scannersRoutes.post('/register', async (c) => {
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

  const tokens = await loadOrderedScannerTokens(db, commerce.id, pointVente.id);

  const { data: existing } = await db
    .from('scanner_devices')
    .select('id')
    .eq('commerce_id', commerce.id)
    .eq('point_vente_id', pointVente.id)
    .eq('scanner_token', scannerToken)
    .maybeSingle();

  if (existing) {
    await db
      .from('scanner_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);

    return c.json({
      data: {
        already_registered: true,
        max_scanners: null,
        current_scanners: tokens.length,
        total_scanners: tokens.length,
        remaining_scanners: null,
        unlimited_scanners: true,
      },
    });
  }

  const { error: insertError } = await db
    .from('scanner_devices')
    .insert({
      commerce_id: commerce.id,
      point_vente_id: pointVente.id,
      scanner_token: scannerToken,
      device_name: deviceName ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      last_seen_at: new Date().toISOString(),
    });

  if (insertError) {
    return c.json({ error: 'Impossible d’enregistrer ce scanner pour le moment.' }, 500);
  }

  const nextTokens = await loadOrderedScannerTokens(db, commerce.id, pointVente.id);
  return c.json({
    data: {
      already_registered: false,
      max_scanners: null,
      current_scanners: nextTokens.length,
      total_scanners: nextTokens.length,
      remaining_scanners: null,
      unlimited_scanners: true,
    },
  }, 201);
});
