import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { authRoutes } from './routes/auth';
import { commercesRoutes } from './routes/commerces';
import { cartesRoutes } from './routes/cartes';
import { clientsRoutes } from './routes/clients';
import { transactionsRoutes } from './routes/transactions';
import { walletRoutes } from './routes/wallet';
import { notificationsRoutes } from './routes/notifications';
import { adminRoutes } from './routes/admin';
import { dashboardRoutes } from './routes/dashboard';
import { uploadRoutes } from './routes/upload';
import { reviewRoutes } from './routes/review';
import { checkoutRoutes } from './routes/checkout';
import { stripeWebhookRoutes } from './routes/stripe-webhook';
import { smsRoutes } from './routes/sms';
import { cronRoutes } from './routes/cron';
import { billingRoutes } from './routes/billing';
import { scannersRoutes } from './routes/scanners';
import { createRateLimitMiddleware } from './middleware/rate-limit';
import { createServiceClient } from '../src/lib/supabase';

const app = new Hono();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://fidelopass.com',
  'https://www.fidelopass.com',
  'http://localhost:3000',
  'http://localhost:4321',
  'http://localhost:5173',
];

const allowedOrigins = Array.from(
  new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .concat(DEFAULT_ALLOWED_ORIGINS),
  ),
);

const globalRateLimit = createRateLimitMiddleware({
  keyPrefix: 'global',
  limit: Number(process.env.RATE_LIMIT_GLOBAL ?? 240),
  windowMs: Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS ?? 60_000),
});

const authRateLimit = createRateLimitMiddleware({
  keyPrefix: 'auth',
  limit: Number(process.env.RATE_LIMIT_AUTH ?? 20),
  windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS ?? 300_000),
});

app.use('*', logger());
app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id')?.trim() || randomUUID();
  const startedAt = Date.now();
  c.header('X-Request-Id', requestId);
  await next();
  c.header('X-Request-Id', requestId);
  const elapsedMs = Date.now() - startedAt;
  c.header('X-Response-Time', `${elapsedMs}ms`);
  if (elapsedMs >= Number(process.env.SLOW_REQUEST_THRESHOLD_MS ?? 1200)) {
    console.warn(`[Slow API] ${c.req.method} ${new URL(c.req.url).pathname} ${elapsedMs}ms requestId=${requestId}`);
  }
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (c.req.url.startsWith('https://')) {
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  await next();
});
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (allowedOrigins.includes(origin)) return origin;
    return '';
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-Point-Vente-Id'],
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
}));
app.use('/api/*', globalRateLimit);
app.use('/api/auth/*', authRateLimit);

app.route('/api/auth', authRoutes);
app.route('/api/commerces', commercesRoutes);
app.route('/api/cartes', cartesRoutes);
app.route('/api/clients', clientsRoutes);
app.route('/api/transactions', transactionsRoutes);
app.route('/api/wallet', walletRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/review', reviewRoutes);
app.route('/api/checkout', checkoutRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/stripe-webhook', stripeWebhookRoutes);
app.route('/api/sms', smsRoutes);
app.route('/api/cron', cronRoutes);
app.route('/api/scanners', scannersRoutes);

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));
app.get('/api/health/deps', async (c) => {
  const db = createServiceClient();
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.HEALTH_DB_TIMEOUT_MS ?? 2000);

  const dbCheck = Promise.race([
    db.from('commerces').select('id', { count: 'exact', head: true }).limit(1),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  const dbResult = await dbCheck;
  const dbOk = Boolean(dbResult && !dbResult.error);
  const dbError = dbResult && dbResult.error ? dbResult.error.message : dbResult ? null : `timeout>${timeoutMs}ms`;

  const services = {
    database: {
      ok: dbOk,
      error: dbError,
      latency_ms: Date.now() - startedAt,
    },
    stripe: {
      ok: Boolean(process.env.STRIPE_SECRET_KEY),
    },
    wallet: {
      apple_ok: Boolean(process.env.APPLE_SIGNER_CERT_PEM && process.env.APPLE_SIGNER_KEY_PEM),
      google_ok: Boolean(process.env.GOOGLE_ISSUER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    },
  };

  const ok = services.database.ok && services.stripe.ok;
  return c.json({ ok, ts: new Date().toISOString(), services }, ok ? 200 : 503);
});
app.notFound((c) => c.json({ error: 'Route introuvable' }, 404));
app.onError((err, c) => {
  console.error('[API Error]', err);
  return c.json({ error: 'Erreur interne du serveur' }, 500);
});

const port = Number(process.env.PORT ?? 3001);
console.log(`API Fidelopass démarrée sur http://localhost:${port}`);

serve({ fetch: app.fetch, port });
