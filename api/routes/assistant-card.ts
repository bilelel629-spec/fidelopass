import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { getEffectivePlanRaw } from '../utils/effective-plan';
import { readRequestedPointVenteId, resolveCommerceAndPointVente } from '../utils/point-vente';

export const assistantCardRoutes = new Hono();

assistantCardRoutes.use('*', authMiddleware);

const fileSchema = z.object({
  type: z.enum(['logo', 'banner', 'photo', 'menu', 'inspiration', 'other']).default('other'),
  label: z.string().max(120).optional().nullable(),
  url: z.string().trim().max(1000).optional().nullable(),
}).passthrough();

const briefSchema = z.object({
  business_name: z.string().trim().min(2).max(160),
  sector: z.string().trim().max(120).optional().nullable(),
  desired_style: z.string().trim().max(600).optional().nullable(),
  preferred_colors: z.string().trim().max(240).optional().nullable(),
  reward_details: z.string().trim().max(300).optional().nullable(),
  logo_url: z.string().trim().max(1000).optional().nullable(),
  inspiration_url: z.string().trim().max(1000).optional().nullable(),
  files: z.array(fileSchema).max(12).optional().default([]),
  notes: z.string().trim().max(1500).optional().nullable(),
});

const decisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  notes: z.string().trim().max(1000).optional().nullable(),
});

type CommerceForAssistant = {
  id: string;
  nom?: string | null;
  email?: string | null;
  plan: string | null;
  plan_override?: string | null;
  onboarding_purchased?: boolean | null;
};

function isMissingAssistantTable(error: { code?: string; message?: string } | null | undefined) {
  const message = error?.message ?? '';
  return error?.code === '42P01' || /assistant_card_briefs|schema cache|does not exist/i.test(message);
}

function normalizeBriefStatus(value: unknown) {
  const status = String(value ?? 'not_started');
  return status.length > 0 ? status : 'not_started';
}

function briefStepFromStatus(status: string) {
  const order = ['not_started', 'brief_received', 'in_progress', 'ready_for_review', 'approved', 'published'];
  const normalized = status === 'changes_requested' ? 'brief_received' : status;
  const index = order.indexOf(normalized);
  return Math.max(0, index);
}

async function resolveAssistantContext(c: Context) {
  const db = createServiceClient();
  const userId = c.get('userId') as string;
  const requestedPointVenteId = readRequestedPointVenteId(c);
  const { commerce, pointVente, pointsVente } = await resolveCommerceAndPointVente<CommerceForAssistant>(
    db,
    userId,
    requestedPointVenteId,
    'id, nom, email, plan, plan_override, onboarding_purchased',
  );
  return { db, commerce, pointVente, pointsVente };
}

/** GET /api/assistant-card/brief — Statut + brief du point de vente actif */
assistantCardRoutes.get('/brief', async (c) => {
  try {
    const { db, commerce, pointVente, pointsVente } = await resolveAssistantContext(c);
    if (!commerce || !pointVente) return c.json({ error: 'Commerce ou point de vente introuvable.' }, 404);

    const { data: brief, error } = await db
      .from('assistant_card_briefs')
      .select('*')
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .maybeSingle();

    if (error && isMissingAssistantTable(error)) {
      return c.json({
        data: {
          table_ready: false,
          purchased: Boolean(commerce.onboarding_purchased),
          commerce: {
            ...commerce,
            effective_plan: getEffectivePlanRaw(commerce),
          },
          point_vente: pointVente,
          points_vente: pointsVente,
          brief: null,
          progress_step: 0,
        },
      });
    }

    if (error) return c.json({ error: 'Impossible de charger le brief assistant.' }, 500);

    const status = normalizeBriefStatus(brief?.status);
    return c.json({
      data: {
        table_ready: true,
        purchased: Boolean(commerce.onboarding_purchased),
        commerce: {
          ...commerce,
          effective_plan: getEffectivePlanRaw(commerce),
        },
        point_vente: pointVente,
        points_vente: pointsVente,
        brief: brief ?? null,
        progress_step: briefStepFromStatus(status),
      },
    });
  } catch (error) {
    console.error('[assistant-card] brief load failed:', error);
    return c.json({ error: 'Impossible de charger l’accompagnement.' }, 500);
  }
});

/** POST /api/assistant-card/brief — Soumission du brief design */
assistantCardRoutes.post('/brief', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = briefSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données de brief invalides.' }, 400);
  }

  try {
    const { db, commerce, pointVente } = await resolveAssistantContext(c);
    if (!commerce || !pointVente) return c.json({ error: 'Commerce ou point de vente introuvable.' }, 404);
    if (!commerce.onboarding_purchased) {
      return c.json({ error: 'L’accompagnement doit être activé avant d’envoyer le brief.' }, 403);
    }

    const nowIso = new Date().toISOString();
    const payload = {
      commerce_id: commerce.id,
      point_vente_id: pointVente.id,
      ...parsed.data,
      status: 'brief_received',
      submitted_at: nowIso,
      updated_at: nowIso,
    };

    const { data, error } = await db
      .from('assistant_card_briefs')
      .upsert(payload, { onConflict: 'commerce_id,point_vente_id' })
      .select('*')
      .single();

    if (error && isMissingAssistantTable(error)) {
      return c.json({
        error: 'La migration assistant_card_briefs doit être exécutée avant d’envoyer le brief.',
        code: 'ASSISTANT_BRIEF_MIGRATION_REQUIRED',
      }, 503);
    }
    if (error) return c.json({ error: error.message }, 500);

    return c.json({ data });
  } catch (error) {
    console.error('[assistant-card] brief save failed:', error);
    return c.json({ error: 'Impossible d’enregistrer le brief.' }, 500);
  }
});

/** PATCH /api/assistant-card/brief/decision — Validation commerçant de la proposition */
assistantCardRoutes.patch('/brief/decision', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Décision invalide.' }, 400);
  }

  try {
    const { db, commerce, pointVente } = await resolveAssistantContext(c);
    if (!commerce || !pointVente) return c.json({ error: 'Commerce ou point de vente introuvable.' }, 404);

    const nowIso = new Date().toISOString();
    const nextStatus = parsed.data.decision;
    const { data, error } = await db
      .from('assistant_card_briefs')
      .update({
        status: nextStatus,
        notes: parsed.data.notes ?? null,
        updated_at: nowIso,
        ...(nextStatus === 'approved' ? { approved_at: nowIso } : {}),
      })
      .eq('commerce_id', commerce.id)
      .eq('point_vente_id', pointVente.id)
      .select('*')
      .single();

    if (error && isMissingAssistantTable(error)) {
      return c.json({ error: 'Migration assistant_card_briefs manquante.' }, 503);
    }
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ data });
  } catch (error) {
    console.error('[assistant-card] brief decision failed:', error);
    return c.json({ error: 'Impossible d’enregistrer la décision.' }, 500);
  }
});
