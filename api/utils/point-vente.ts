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
  rue?: string | null;
  ville?: string | null;
  code_postal?: string | null;
  pays?: string | null;
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

  const pointVenteSelect = 'id, commerce_id, nom, adresse, rue, ville, code_postal, pays, latitude, longitude, rayon_geo, principal, actif, created_at';
  const pointVenteFallbackSelect = 'id, commerce_id, nom, adresse, latitude, longitude, rayon_geo, principal, actif, created_at';

  const primaryPointsResult = await db
    .from('points_vente')
    .select(pointVenteSelect)
    .eq('commerce_id', commerce.id)
    .eq('actif', true)
    .order('principal', { ascending: false })
    .order('created_at', { ascending: true });
  let pointsVente = primaryPointsResult.data as unknown[] | null;
  let pointsVenteError = primaryPointsResult.error;

  if (pointsVenteError) {
    const missingAddressDetails = /rue|ville|code_postal|pays|schema cache|does not exist/i.test(pointsVenteError.message ?? '');
    if (!missingAddressDetails) throw pointsVenteError;

    const fallback = await db
      .from('points_vente')
      .select(pointVenteFallbackSelect)
      .eq('commerce_id', commerce.id)
      .eq('actif', true)
      .order('principal', { ascending: false })
      .order('created_at', { ascending: true });

    pointsVente = fallback.data as unknown[] | null;
    pointsVenteError = fallback.error;
    if (pointsVenteError) throw pointsVenteError;
  }

  let points = (pointsVente ?? []) as PointVenteRow[];

  // Résilience: certains commerces créés pendant le checkout n'ont pas encore de point de vente.
  // On bootstrap automatiquement un point "Principal" pour éviter les blocages d'onboarding.
  if (points.length === 0) {
    const fallbackName = `${(commerce.nom ?? 'Point de vente').trim() || 'Point de vente'} — Principal`;
    const { data: createdPoint, error: createPointError } = await db
      .from('points_vente')
      .insert({
        commerce_id: commerce.id,
        nom: fallbackName,
        adresse: commerce.adresse ?? null,
        latitude: commerce.latitude ?? null,
        longitude: commerce.longitude ?? null,
        rayon_geo: commerce.rayon_geo ?? 1000,
        principal: true,
        actif: true,
      })
      .select(pointVenteFallbackSelect)
      .single();

    if (createPointError) {
      throw createPointError;
    }

    if (createdPoint) {
      points = [createdPoint as PointVenteRow];
    }
  }

  const fallbackPoint = points.find((point) => point.principal) ?? points[0] ?? null;
  const selectedPoint = requestedPointVenteId
    ? points.find((point) => point.id === requestedPointVenteId) ?? fallbackPoint
    : fallbackPoint;

  return {
    commerce: commerce as T,
    pointVente: selectedPoint ?? fallbackPoint,
    pointsVente: points,
  };
}
