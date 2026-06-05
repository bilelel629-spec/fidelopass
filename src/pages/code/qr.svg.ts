import type { APIRoute } from 'astro';
import QRCode from 'qrcode';

export const GET: APIRoute = async ({ url }) => {
  const data = (url.searchParams.get('data') ?? '').trim();
  const sizeRaw = Number(url.searchParams.get('size') ?? 480);
  const size = Number.isFinite(sizeRaw) ? Math.max(180, Math.min(720, Math.round(sizeRaw))) : 480;

  if (!data || data.length > 200) {
    return new Response('Code invalide', { status: 400 });
  }

  const svg = await QRCode.toString(data, {
    type: 'svg',
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
