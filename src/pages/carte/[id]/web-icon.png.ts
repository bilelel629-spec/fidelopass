import type { APIRoute } from 'astro';

type PublicCardPayload = {
  data?: {
    carte?: {
      logo_url?: string | null;
    };
    commerce?: {
      logo_url?: string | null;
    };
  };
};

const API_BASE = (
  process.env.API_URL
  || import.meta.env.PUBLIC_API_URL
  || (import.meta.env.PROD ? 'https://api.fidelopass.com' : 'http://localhost:3001')
).replace(/\/$/, '');

function safeImageUrl(value: unknown) {
  const url = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

async function loadLogoUrl(cardId: string) {
  try {
    const response = await fetch(`${API_BASE}/api/cartes/${encodeURIComponent(cardId)}/public`);
    if (!response.ok) return '';
    const payload = await response.json() as PublicCardPayload;
    return safeImageUrl(payload.data?.carte?.logo_url || payload.data?.commerce?.logo_url);
  } catch {
    return '';
  }
}

async function fallbackIcon(origin: string) {
  const response = await fetch(`${origin}/icons/icon-512.png`).catch(() => null);
  if (!response?.ok) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/icons/icon-512.png' },
    });
  }
  return new Response(await response.arrayBuffer(), {
    headers: {
      'Content-Type': response.headers.get('content-type') || 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export const GET: APIRoute = async ({ params, url }) => {
  const cardId = params.id ?? '';
  const logoUrl = await loadLogoUrl(cardId);

  if (!logoUrl) return fallbackIcon(url.origin);

  const response = await fetch(logoUrl).catch(() => null);
  if (!response?.ok) return fallbackIcon(url.origin);

  return new Response(await response.arrayBuffer(), {
    headers: {
      'Content-Type': response.headers.get('content-type') || 'image/png',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
};
