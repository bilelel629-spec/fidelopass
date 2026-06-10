import type { APIRoute } from 'astro';

const SITE = 'https://www.fidelopass.com';

// Pages publiques marketing à indexer (le site est en SSR : on liste manuellement
// les routes publiques, en excluant dashboard/admin/app/login/register, etc.).
const PAGES: Array<{ path: string; priority: string; changefreq: string }> = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/pricing', priority: '0.9', changefreq: 'monthly' },
  { path: '/comment-ca-fonctionne', priority: '0.8', changefreq: 'monthly' },
  { path: '/cas-d-utilisation', priority: '0.8', changefreq: 'monthly' },
  { path: '/devenir-revendeur', priority: '0.7', changefreq: 'monthly' },
  { path: '/create-stamp-card', priority: '0.7', changefreq: 'monthly' },
  { path: '/create-points-card', priority: '0.7', changefreq: 'monthly' },
  { path: '/contact', priority: '0.5', changefreq: 'yearly' },
  { path: '/help', priority: '0.5', changefreq: 'monthly' },
  { path: '/acces', priority: '0.4', changefreq: 'yearly' },
];

export const GET: APIRoute = () => {
  const today = new Date().toISOString().split('T')[0];
  const urls = PAGES.map(({ path, priority, changefreq }) => `  <url>
    <loc>${SITE}${path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
