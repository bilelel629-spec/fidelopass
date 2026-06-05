import type { APIRoute } from 'astro';

type PublicCardPayload = {
  data?: {
    carte?: {
      nom?: string | null;
      logo_url?: string | null;
      couleur_fond?: string | null;
      couleur_accent?: string | null;
    };
    commerce?: {
      nom?: string | null;
      logo_url?: string | null;
    };
  };
};

const API_BASE = (
  process.env.API_URL
  || import.meta.env.PUBLIC_API_URL
  || (import.meta.env.PROD ? 'https://api.fidelopass.com' : 'http://localhost:3001')
).replace(/\/$/, '');

function cleanName(value: unknown) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text.slice(0, 48) : '';
}

function safeColor(value: unknown, fallback: string) {
  const color = String(value ?? '').trim();
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? color : fallback;
}

async function loadPublicCard(cardId: string): Promise<PublicCardPayload['data'] | null> {
  try {
    const response = await fetch(`${API_BASE}/api/cartes/${encodeURIComponent(cardId)}/public`);
    if (!response.ok) return null;
    const payload = await response.json() as PublicCardPayload;
    return payload.data ?? null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ params, url }) => {
  const cardId = params.id ?? '';
  const clientId = url.searchParams.get('client');
  const startUrl = `/carte/${encodeURIComponent(cardId)}/web${clientId ? `?client=${encodeURIComponent(clientId)}` : ''}`;
  const data = await loadPublicCard(cardId);
  const appName = cleanName(data?.commerce?.nom) || cleanName(data?.carte?.nom) || 'Carte web Fidelopass';
  const iconSrc = `/carte/${encodeURIComponent(cardId)}/web-icon.png${clientId ? `?client=${encodeURIComponent(clientId)}` : ''}`;
  const themeColor = safeColor(data?.carte?.couleur_accent, '#2563eb');
  const backgroundColor = safeColor(data?.carte?.couleur_fond, '#f8fbff');

  return new Response(JSON.stringify({
    name: appName,
    short_name: appName.slice(0, 12),
    description: `Carte de fidelite ${appName}.`,
    start_url: startUrl,
    scope: `/carte/${encodeURIComponent(cardId)}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: backgroundColor,
    theme_color: themeColor,
    icons: [
      { src: iconSrc, sizes: '192x192', purpose: 'any maskable' },
      { src: iconSrc, sizes: '512x512', purpose: 'any maskable' },
    ],
  }), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
