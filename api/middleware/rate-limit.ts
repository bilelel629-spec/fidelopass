import type { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Purge périodique des entrées expirées (toutes les 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Middleware de rate limiting par IP.
 * @param limit  Nombre max de requêtes dans la fenêtre
 * @param windowMs  Durée de la fenêtre en ms
 */
export function rateLimit(limit: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const ip =
      (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'unknown';

    const key = `${ip}:${c.req.method}:${c.req.path}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > limit) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: 'Trop de requêtes. Réessayez dans quelques secondes.' }, 429);
      }
    }

    await next();
  };
}
