interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * Convertit une adresse en coordonnées GPS via Nominatim (OpenStreetMap).
 * Gratuit, sans clé API.
 */
export async function geocodeAddress(adresse: string): Promise<Coordinates | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', adresse);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'fr');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        // Nominatim exige un User-Agent identifiable
        'User-Agent': 'Fidelopass/1.0 (contact@pulse-agency.fr)',
      },
    });

    if (!res.ok) return null;

    const results = await res.json() as Array<{ lat: string; lon: string }>;
    if (!results.length) return null;

    return {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };
  } catch {
    return null;
  }
}
