import type { Context, Next } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { getResellerByUserId, type ResellerRecord } from '../services/reseller';

export type ResellerContext = {
  reseller_id: string;
  reseller: ResellerRecord;
};

export async function resellerMiddleware(c: Context, next: Next) {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Utilisateur non authentifié' }, 401);

  const db = createServiceClient();
  let reseller: ResellerRecord | null = null;
  try {
    reseller = await getResellerByUserId(db, userId);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    const missingMigration = err.code === '42P01' || err.code === 'PGRST205' || /resellers/i.test(err.message ?? '');
    if (missingMigration) return c.json({ error: 'Module revendeur non initialisé.' }, 503);
    return c.json({ error: 'Impossible de vérifier l’accès revendeur.' }, 500);
  }

  if (!reseller) return c.json({ error: 'Accès réservé aux revendeurs Fidelopass.' }, 403);
  if (reseller.status === 'pending') return c.json({ error: 'Votre dossier revendeur est en attente de validation.' }, 403);
  if (reseller.status === 'suspended') return c.json({ error: 'Votre espace revendeur est suspendu.' }, 403);

  c.set('resellerContext', {
    reseller_id: reseller.id,
    reseller,
  } satisfies ResellerContext);

  await next();
}
