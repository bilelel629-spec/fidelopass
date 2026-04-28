export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface AddressSuggestion extends Coordinates {
  id: string;
  label: string;
  rue: string | null;
  ville: string | null;
  code_postal: string | null;
  pays: string | null;
  provider: 'geoapify' | 'nominatim';
}

const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY?.trim() ?? '';
const USER_AGENT = 'Fidelopass/1.0 (contact@duo-agency.com)';

function clean(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

function toNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCountry(country: string | null, countryCode?: string | null) {
  if (country) return country;
  const code = String(countryCode ?? '').toLowerCase();
  if (code === 'fr') return 'France';
  if (code === 'ch') return 'Suisse';
  return null;
}

function fromGeoapifyFeature(feature: any): AddressSuggestion | null {
  const props = feature?.properties ?? {};
  const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const longitude = toNumber(props.lon ?? coords[0]);
  const latitude = toNumber(props.lat ?? coords[1]);
  if (latitude === null || longitude === null) return null;

  const city = clean(props.city) ?? clean(props.town) ?? clean(props.village) ?? clean(props.municipality);
  const street = clean(props.address_line1) ?? ([clean(props.housenumber), clean(props.street)].filter(Boolean).join(' ') || null);
  const label = clean(props.formatted) ?? [street, clean(props.postcode), city].filter(Boolean).join(', ');
  if (!label) return null;

  return {
    id: clean(props.place_id) ?? `${latitude},${longitude},${label}`,
    label,
    rue: street,
    ville: city,
    code_postal: clean(props.postcode),
    pays: normalizeCountry(clean(props.country), clean(props.country_code)),
    latitude,
    longitude,
    provider: 'geoapify',
  };
}

function fromNominatimResult(result: any): AddressSuggestion | null {
  const latitude = toNumber(result?.lat);
  const longitude = toNumber(result?.lon);
  if (latitude === null || longitude === null) return null;

  const address = result?.address ?? {};
  const street = [clean(address.house_number), clean(address.road ?? address.pedestrian ?? address.footway)]
    .filter(Boolean)
    .join(' ') || null;
  const city = clean(address.city) ?? clean(address.town) ?? clean(address.village) ?? clean(address.municipality);
  const label = clean(result?.display_name) ?? [street, clean(address.postcode), city].filter(Boolean).join(', ');
  if (!label) return null;

  return {
    id: clean(result?.place_id) ?? `${latitude},${longitude},${label}`,
    label,
    rue: street,
    ville: city,
    code_postal: clean(address.postcode),
    pays: normalizeCountry(clean(address.country), clean(address.country_code)),
    latitude,
    longitude,
    provider: 'nominatim',
  };
}

async function fetchGeoapifyAutocomplete(query: string, limit: number): Promise<AddressSuggestion[]> {
  if (!GEOAPIFY_API_KEY) return [];

  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('lang', 'fr');
  url.searchParams.set('filter', 'countrycode:fr,ch');
  url.searchParams.set('apiKey', GEOAPIFY_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) return [];

  const payload = await res.json() as { features?: any[] };
  return (payload.features ?? [])
    .map(fromGeoapifyFeature)
    .filter((item): item is AddressSuggestion => Boolean(item));
}

async function fetchNominatimSearch(query: string, limit: number): Promise<AddressSuggestion[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('countrycodes', 'fr,ch');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return [];

  const results = await res.json() as any[];
  return results
    .map(fromNominatimResult)
    .filter((item): item is AddressSuggestion => Boolean(item));
}

async function fetchGeoapifyReverse(latitude: number, longitude: number): Promise<AddressSuggestion | null> {
  if (!GEOAPIFY_API_KEY) return null;

  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('lang', 'fr');
  url.searchParams.set('apiKey', GEOAPIFY_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const payload = await res.json() as { features?: any[] };
  return fromGeoapifyFeature(payload.features?.[0]);
}

async function fetchNominatimReverse(latitude: number, longitude: number): Promise<AddressSuggestion | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;

  const result = await res.json();
  return fromNominatimResult(result);
}

export async function autocompleteAddress(query: string, limit = 6): Promise<AddressSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  const safeLimit = Math.max(1, Math.min(limit, 8));

  try {
    const geoapifyResults = await fetchGeoapifyAutocomplete(trimmed, safeLimit);
    if (geoapifyResults.length > 0) return geoapifyResults;
  } catch (error) {
    console.warn('[geocoding] Geoapify autocomplete failed, using fallback', error);
  }

  try {
    return await fetchNominatimSearch(trimmed, safeLimit);
  } catch (error) {
    console.warn('[geocoding] Nominatim autocomplete failed', error);
    return [];
  }
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<AddressSuggestion | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  try {
    const geoapifyResult = await fetchGeoapifyReverse(latitude, longitude);
    if (geoapifyResult) return geoapifyResult;
  } catch (error) {
    console.warn('[geocoding] Geoapify reverse failed, using fallback', error);
  }

  try {
    return await fetchNominatimReverse(latitude, longitude);
  } catch (error) {
    console.warn('[geocoding] Nominatim reverse failed', error);
    return null;
  }
}

export async function geocodeAddress(adresse: string): Promise<Coordinates | null> {
  const first = (await autocompleteAddress(adresse, 1))[0];
  if (!first) return null;
  return {
    latitude: first.latitude,
    longitude: first.longitude,
  };
}
