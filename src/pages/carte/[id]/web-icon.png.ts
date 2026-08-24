import type { APIRoute } from 'astro';
import sharp from 'sharp';

type PublicCardPayload = {
  data?: {
    carte?: {
      logo_url?: string | null;
      couleur_fond?: string | null;
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16) || 0,
    g: parseInt(clean.slice(2, 4), 16) || 0,
    b: parseInt(clean.slice(4, 6), 16) || 0,
  };
}

async function loadCardPublicData(cardId: string) {
  try {
    const response = await fetch(`${API_BASE}/api/cartes/${encodeURIComponent(cardId)}/public`);
    if (!response.ok) return null;
    const payload = await response.json() as PublicCardPayload;
    return payload.data ?? null;
  } catch {
    return null;
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
  const data = await loadCardPublicData(cardId);

  const logoUrl = safeImageUrl(data?.carte?.logo_url || data?.commerce?.logo_url);
  const bgHex = /^#[0-9A-Fa-f]{6}$/.test(data?.carte?.couleur_fond ?? '') ? data!.carte!.couleur_fond! : '#0f172a';

  if (!logoUrl) return fallbackIcon(url.origin);

  const logoResponse = await fetch(logoUrl).catch(() => null);
  if (!logoResponse?.ok) return fallbackIcon(url.origin);

  const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());
  const bg = hexToRgb(bgHex);
  const SIZE = 512;
  const LOGO_SIZE = Math.round(SIZE * 0.62);

  try {
    const resizedLogo = await sharp(logoBuffer)
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'inside', withoutEnlargement: false })
      .toBuffer();

    const icon = await sharp({
      create: {
        width: SIZE,
        height: SIZE,
        channels: 4,
        background: { r: bg.r, g: bg.g, b: bg.b, alpha: 1 },
      },
    })
      .composite([{ input: resizedLogo, gravity: 'centre' }])
      .png()
      .toBuffer();

    return new Response(new Uint8Array(icon).buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return fallbackIcon(url.origin);
  }
};
