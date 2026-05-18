import { defineMiddleware } from 'astro:middleware';

// La protection des routes dashboard/admin est gérée côté client
// (DashboardLayout et AdminLayout vérifient la session Supabase via localStorage)
// Le middleware SSR ne peut pas lire la session Supabase (stockée en localStorage, pas en cookie)
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, searchParams } = context.url;

  if (pathname === '/en' || pathname.startsWith('/en/')) {
    const frenchPath = pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    return context.redirect(frenchPath, 302);
  }

  if (searchParams.get('lang') === 'en') {
    const url = new URL(context.url);
    url.searchParams.delete('lang');
    return context.redirect(`${url.pathname}${url.search}`, 302);
  }

  return next();
});
