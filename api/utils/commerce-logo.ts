/**
 * Fusionne le logo de la carte avec celui du commerce.
 * Priorité : carte.logo_url > commerce.logo_url
 * Fusionne aussi les coordonnées GPS depuis points_vente si présentes.
 */
export function withEffectiveCommerceLogo<
  T extends {
    logo_url?: string | null;
    commerces?: {
      logo_url?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      rayon_geo?: number | null;
    } | null;
    points_vente?: {
      latitude?: number | null;
      longitude?: number | null;
      rayon_geo?: number | null;
    } | null;
  }
>(carte: T | null): T | null {
  if (!carte?.commerces) return carte;
  carte.commerces.logo_url = carte.logo_url ?? carte.commerces.logo_url ?? null;
  if (carte.points_vente) {
    carte.commerces.latitude = carte.points_vente.latitude ?? carte.commerces.latitude ?? null;
    carte.commerces.longitude = carte.points_vente.longitude ?? carte.commerces.longitude ?? null;
    carte.commerces.rayon_geo = carte.points_vente.rayon_geo ?? carte.commerces.rayon_geo ?? null;
  }
  return carte;
}
