import { createServiceClient } from '../../src/lib/supabase';

const cache = new Map<string, { value: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/** URL commerçant ajoutée aux passes Wallet sans exposer de donnée client. */
export async function getWidgetPortalUrl(commerceId: string | null | undefined): Promise<string | null> {
  if (!commerceId) return null;
  const cached = cache.get(commerceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const { data, error } = await createServiceClient()
      .from('widget_configs')
      .select('portal_url')
      .eq('commerce_id', commerceId)
      .eq('enabled', true)
      .maybeSingle();
    if (error) throw error;
    let value: string | null = null;
    if (typeof data?.portal_url === 'string') {
      const url = new URL(data.portal_url);
      if (url.protocol === 'https:') value = url.toString();
    }
    cache.set(commerceId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    // Compatibilité pendant le déploiement progressif de la migration.
    console.warn('[widget-portal] URL indisponible', error instanceof Error ? error.message : 'erreur inconnue');
    return null;
  }
}
