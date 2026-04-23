import type { Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';

type CommerceRow = {
  id: string;
  plan: string | null;
  plan_override?: string | null;
  nom?: string | null;
  adresse?: string | null;
  logo_url?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rayon_geo?: number | null;
};

export type PointVenteRow = {
  id: string;
  commerce_id: string;
  nom: string;
  adresse: string | null;
  latitude: number | null;
  longitude: number | null;
  rayon_geo: number | null;
  principal: boolean;
  actif: boolean;
  created_at?: string;
};

export function readRequestedPointVenteId(c: Context): string | null {
  const headerValue = c.req.header('x-point-vente-id');
  const queryValue = c.req.query('point_vente_id');
  const value = (headerValue ?? queryValue ?? '').trim();
  return value.length > 0 ? value : null;
}

export async function resolveCommerceAndPointVente<T extends CommerceRow = CommerceRow>(
  db: SupabaseClient,
  userId: string,
  requestedPointVenteId: string | null,
  commerceSelect = 'id, plan',
): Promise<{ commerce: T | null; pointVente: PointVenteRow | null; pointsVente: PointVenteRow[] }> {
  const requestedSelect = commerceSelect.trim();
  const normalizedSelect = (() => {
    const select = commerceSelect.trim();
    if (select === '*' || select.includes('plan_override')) return select;
    return `${select}, plan_override`;
  })();

  let commerce: T | null = null;
  let commerceErrorMessage = '';

  const { data: commerceWithOverride, error: commerceWithOverrideError } = await db
    .from('commerces')
    .select(normalizedSelect)
    .eq('user_id', userId)
    .single();

  if (!commerceWithOverrideError) {
    commerce = (commerceWithOverride as unknown as T | null) ?? null;
  } else {
    commerceErrorMessage = commerceWithOverrideError.message ?? '';
    const missingOverrideColumn = /plan_override/i.test(commerceErrorMessage)
      && (/does not exist/i.test(commerceErrorMessage) || /schema cache/i.test(commerceErrorMessage));

    if (!missingOverrideColumn) {
      throw commerceWithOverrideError;
    }

    const cleanedFallbackSelect = requestedSelect === '*'
      ? '*'
      : requestedSelect
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== 'plan_override')
        .join(', ');
    const fallbackSelect = cleanedFallbackSelect === '' ? 'id, plan' : cleanedFallbackSelect;
    const { data: fallbackCommerce, error: fallbackError } = await db
      .from('commerces')
      .select(fallbackSelect)
      .eq('user_id', userId)
      .single();

    if (fallbackError) throw fallbackError;
    commerce = (fallbackCommerce as unknown as T | null) ?? null;
  }

  if (!commerce) {
    return { commerce: null, pointVente: null, pointsVente: [] };
  }

  const { data: pointsVente, error: pointsVenteError } = await db
    .from('points_vente')
    .select('id, commerce_id, nom, adresse, latitude, longitude, rayon_geo, principal, actif, created_at')
    .eq('commerce_id', commerce.id)
    .eq('actif', true)
    .order('principal', { ascending: false })
    .order('created_at', { ascending: true });

  if (pointsVenteError) {
    throw pointsVenteError;
  }

  const points = (pointsVente ?? []) as PointVenteRow[];
  const fallbackPoint = points.find((point) => point.principal) ?? points[0] ?? null;
  const selectedPoint = requestedPointVenteId
    ? points.find((point) => point.id === requestedPointVenteId) ?? null
    : fallbackPoint;

  return {
    commerce: commerce as T,
    pointVente: selectedPoint ?? fallbackPoint,
    pointsVente: points,
  };
}
