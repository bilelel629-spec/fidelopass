import type { Context, Next } from 'hono';

type RateLimitOptions = {
  keyPrefix: string;
  limit: number;
  windowMs: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const entries = new Map<string, RateLimitEntry>();

function getClientIp(c: Context) {
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() ?? 'unknown';
  return c.req.header('x-real-ip') ?? 'unknown';
}

function setRateHeaders(c: Context, limit: number, remaining: number, resetAt: number) {
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(remaining, 0)));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  const { keyPrefix, limit, windowMs } = options;

  return async (c: Context, next: Next) => {
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    const now = Date.now();
    const key = `${keyPrefix}:${getClientIp(c)}`;
    const current = entries.get(key);

    if (!current || current.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      setRateHeaders(c, limit, limit - 1, now + windowMs);
      await next();
      return;
    }

    if (current.count >= limit) {
      setRateHeaders(c, limit, 0, current.resetAt);
      c.header('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return c.json(
        {
          error: 'Trop de requêtes, merci de réessayer dans quelques instants.',
          code: 'RATE_LIMITED',
        },
        429,
      );
    }

    current.count += 1;
    entries.set(key, current);
    setRateHeaders(c, limit, limit - current.count, current.resetAt);
    await next();
  };
}
