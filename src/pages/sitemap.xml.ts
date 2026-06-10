import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://www.fidelopass.com';

// Pages publiques marketing à indexer (le site est en SSR : on liste manuellement
// les routes publiques, en excluant dashboard/admin/app/login/register, etc.).
const PAGES: Array<{ path: string; priority: string; changefreq: string }> = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/pricing', priority: '0.9', changefreq: 'monthly' },
  { path: '/faq', priority: '0.8', changefreq: 'monthly' },
  { path: '/blog', priority: '0.8', changefreq: 'weekly' },
  { path: '/comment-ca-fonctionne', priority: '0.8', changefreq: 'monthly' },
  { path: '/cas-d-utilisation', priority: '0.8', changefreq: 'monthly' },
  { path: '/devenir-revendeur', priority: '0.7', changefreq: 'monthly' },
  { path: '/create-stamp-card', priority: '0.7', changefreq: 'monthly' },
  { path: '/create-points-card', priority: '0.7', changefreq: 'monthly' },
  { path: '/contact', priority: '0.5', changefreq: 'yearly' },
  { path: '/help', priority: '0.5', changefreq: 'monthly' },
  { path: '/acces', priority: '0.4', changefreq: 'yearly' },
];

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().split('T')[0];

  // Articles de blog (ajoutés dynamiquement depuis la collection)
  let blogEntries: Array<{ path: string; priority: string; changefreq: string; lastmod: string }> = [];
  try {
    const posts = await getCollection('blog');
    blogEntries = posts.map((post) => ({
      path: `/blog/${post.id}`,
      priority: '0.7',
      changefreq: 'monthly',
      lastmod: (post.data.updatedDate ?? post.data.pubDate).toISOString().split('T')[0],
    }));
  } catch { /* collection indisponible → on garde au moins les pages marketing */ }

  const staticUrls = PAGES.map(({ path, priority, changefreq }) => `  <url>
    <loc>${SITE}${path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`);
  const blogUrls = blogEntries.map(({ path, priority, changefreq, lastmod }) => `  <url>
    <loc>${SITE}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`);
  const urls = [...staticUrls, ...blogUrls].join('\n');

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
