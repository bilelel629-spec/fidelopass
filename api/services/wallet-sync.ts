import { createServiceClient } from '../../src/lib/supabase';
import { pushApplePassUpdate } from './apple-wallet';
import { upsertLoyaltyClass, updateGooglePassObject } from './google-wallet';

type WalletSyncResult = {
  cartes: number;
  clients: number;
  googleUpdated: number;
  applePushed: number;
};

function normalizeRewardsConfig(raw: unknown): Array<{ seuil: number; recompense: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const seuil = Number((item as { seuil?: unknown }).seuil ?? 0);
      const recompense = String((item as { recompense?: unknown }).recompense ?? '').trim();
      if (!Number.isFinite(seuil) || seuil <= 0 || !recompense) return null;
      return { seuil, recompense };
    })
    .filter((item): item is { seuil: number; recompense: string } => !!item);
}

function normalizeVipTiers(raw: unknown): Array<{ nom: string; seuil: number; avantage?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const nom = String((item as { nom?: unknown }).nom ?? '').trim();
      const seuil = Number((item as { seuil?: unknown }).seuil ?? 0);
      const avantage = String((item as { avantage?: unknown }).avantage ?? '').trim();
      if (!nom || !Number.isFinite(seuil) || seuil <= 0) return null;
      return { nom, seuil, ...(avantage ? { avantage } : {}) };
    })
    .filter((item): item is { nom: string; seuil: number; avantage?: string } => !!item);
}

async function syncWalletForCarteId(carteId: string): Promise<WalletSyncResult> {
  const db = createServiceClient();

  const { data: carteRow, error: carteError } = await db
    .from('cartes')
    .select(`
      id,
      commerce_id,
      point_vente_id,
      nom,
      type,
      tampons_total,
      points_recompense,
      recompense_description,
      couleur_fond,
      couleur_texte,
      couleur_accent,
      push_icon_bg_color,
      message_geo,
      logo_url,
      strip_url,
      strip_position,
      tampon_icon_url,
      tampon_icon_scale,
      barcode_type,
      label_client,
      couleur_fond_2,
      gradient_angle,
      pattern_type,
      tampon_emoji,
      strip_layout,
      banner_overlay_opacity,
      branding_powered_by_enabled,
      google_maps_url,
      rewards_config,
      vip_tiers
    `)
    .eq('id', carteId)
    .maybeSingle();

  if (carteError || !carteRow) {
    if (carteError) console.error('[wallet-sync carte]', carteError);
    return { cartes: 0, clients: 0, googleUpdated: 0, applePushed: 0 };
  }

  const [{ data: commerceData, error: commerceError }, { data: pointVenteData, error: pointError }] = await Promise.all([
    db
      .from('commerces')
      .select('nom, logo_url, plan')
      .eq('id', carteRow.commerce_id)
      .maybeSingle(),
    db
      .from('points_vente')
      .select('nom, latitude, longitude, rayon_geo')
      .eq('id', carteRow.point_vente_id)
      .maybeSingle(),
  ]);

  if (commerceError || !commerceData) {
    if (commerceError) console.error('[wallet-sync commerce]', commerceError);
    return { cartes: 0, clients: 0, googleUpdated: 0, applePushed: 0 };
  }
  if (pointError) {
    console.error('[wallet-sync point_vente]', pointError);
  }

  const carteForWallet = {
    ...(carteRow as Record<string, unknown>),
    rewards_config: normalizeRewardsConfig((carteRow as { rewards_config?: unknown }).rewards_config),
    vip_tiers: normalizeVipTiers((carteRow as { vip_tiers?: unknown }).vip_tiers),
    commerces: {
      nom: pointVenteData?.nom ?? commerceData.nom ?? '',
      logo_url: commerceData.logo_url ?? null,
      latitude: pointVenteData?.latitude ?? null,
      longitude: pointVenteData?.longitude ?? null,
      rayon_geo: pointVenteData?.rayon_geo ?? 1000,
      plan: commerceData.plan ?? 'starter',
    },
  };

  const { data: clients, error: clientsError } = await db
    .from('clients')
    .select('id, nom, points_actuels, tampons_actuels, recompenses_obtenues, google_pass_id, apple_pass_serial')
    .eq('carte_id', carteId);

  if (clientsError) {
    console.error('[wallet-sync clients]', clientsError);
    return { cartes: 1, clients: 0, googleUpdated: 0, applePushed: 0 };
  }

  const walletClients = clients ?? [];
  const googleClients = walletClients.filter((client) => !!client.google_pass_id);
  const appleClients = walletClients.filter((client) => !!client.apple_pass_serial);

  let googleUpdated = 0;
  let applePushed = 0;

  if (googleClients.length > 0) {
    await upsertLoyaltyClass(carteForWallet as Parameters<typeof upsertLoyaltyClass>[0]).catch((err) => {
      console.error('[wallet-sync google class]', err);
    });

    const googleResults = await Promise.allSettled(
      googleClients.map((client) =>
        updateGooglePassObject(client.google_pass_id as string, carteForWallet as Parameters<typeof updateGooglePassObject>[1], {
          id: client.id,
          nom: client.nom ?? null,
          points_actuels: client.points_actuels,
          tampons_actuels: client.tampons_actuels,
          recompenses_obtenues: client.recompenses_obtenues ?? 0,
        }),
      ),
    );
    googleUpdated = googleResults.filter((result) => result.status === 'fulfilled').length;
  }

  if (appleClients.length > 0) {
    const { data: registrations, error: registrationsError } = await db
      .from('apple_pass_registrations')
      .select('client_id, push_token, pass_type_identifier')
      .in('client_id', appleClients.map((client) => client.id));

    if (registrationsError) {
      console.error('[wallet-sync apple registrations]', registrationsError);
    } else {
      const passTypeId = process.env.APPLE_PASS_TYPE_ID ?? '';
      const uniqueRegistrations = Array.from(
        new Map((registrations ?? []).map((registration) => [registration.push_token, registration])).values(),
      );
      const appleResults = await Promise.allSettled(
        uniqueRegistrations.map((registration) =>
          pushApplePassUpdate(registration.push_token, passTypeId || registration.pass_type_identifier),
        ),
      );
      applePushed = appleResults.filter((result) => result.status === 'fulfilled').length;
    }
  }

  return {
    cartes: 1,
    clients: walletClients.length,
    googleUpdated,
    applePushed,
  };
}

export async function syncWalletForPointVente(pointVenteId: string): Promise<WalletSyncResult> {
  const db = createServiceClient();
  const { data: cartes, error } = await db
    .from('cartes')
    .select('id')
    .eq('point_vente_id', pointVenteId);

  if (error) {
    console.error('[wallet-sync point-vente cartes]', error);
    return { cartes: 0, clients: 0, googleUpdated: 0, applePushed: 0 };
  }

  const carteIds = (cartes ?? []).map((item) => item.id).filter(Boolean);
  if (carteIds.length === 0) return { cartes: 0, clients: 0, googleUpdated: 0, applePushed: 0 };

  const perCardResults = await Promise.all(carteIds.map((id) => syncWalletForCarteId(id)));
  return perCardResults.reduce<WalletSyncResult>(
    (acc, current) => ({
      cartes: acc.cartes + current.cartes,
      clients: acc.clients + current.clients,
      googleUpdated: acc.googleUpdated + current.googleUpdated,
      applePushed: acc.applePushed + current.applePushed,
    }),
    { cartes: 0, clients: 0, googleUpdated: 0, applePushed: 0 },
  );
}
