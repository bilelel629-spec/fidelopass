import { defineMiddleware } from 'astro:middleware';

// La protection des routes dashboard/admin est gérée côté client
// (DashboardLayout et AdminLayout vérifient la session Supabase via localStorage)
// Le middleware SSR ne peut pas lire la session Supabase (stockée en localStorage, pas en cookie)
export const onRequest = defineMiddleware(async (_context, next) => {
  return next();
});
