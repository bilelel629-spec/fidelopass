import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ params, url }) => {
  const cardId = params.id ?? '';
  const clientId = url.searchParams.get('client');
  const startUrl = `/carte/${encodeURIComponent(cardId)}/web${clientId ? `?client=${encodeURIComponent(clientId)}` : ''}`;

  return new Response(JSON.stringify({
    name: 'Carte web Fidelopass',
    short_name: 'Fidelopass',
    description: 'Votre carte de fidelite Fidelopass en version web.',
    start_url: startUrl,
    scope: `/carte/${encodeURIComponent(cardId)}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f8fbff',
    theme_color: '#2563eb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
