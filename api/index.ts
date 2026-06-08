import 'dotenv/config';
import { Hono } from 'hono';
import type { ApiEnv } from './types';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
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
import { refreshRecentlyChangedWallets } from './routes/cron';
import { billingRoutes } from './routes/billing';
import { scannersRoutes } from './routes/scanners';
import { merchantScanRoutes } from './routes/merchant-scan';
import { geocodingRoutes } from './routes/geocoding';
import { assistantCardRoutes } from './routes/assistant-card';
import { resellerRoutes } from './routes/reseller';
import { publicResellerRoutes } from './routes/public-reseller';
import { createServiceClient } from '../src/lib/supabase';
import { withCronLock } from './services/cron-lock';
import { authMiddleware } from './middleware/auth';
import { adminMiddleware } from './middleware/admin';

const app = new Hono<ApiEnv>();

const ALLOWED_ORIGINS = Array.from(new Set([
  'https://www.fidelopass.com',
  'https://fidelopass.com',
  'https://api.fidelopass.com',
  ...(process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:4321', 'http://localhost:3000', 'http://localhost:3001'] : []),
]));

app.use('*', logger());
app.use('*', cors({
  origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]),
  allowHeaders: ['Content-Type', 'Authorization', 'X-Point-Vente-Id', 'X-Scanner-Token'],
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
}));

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
app.route('/api/merchant', merchantScanRoutes);
app.route('/api/geocoding', geocodingRoutes);
app.route('/api/assistant-card', assistantCardRoutes);
app.route('/api/reseller', resellerRoutes);
app.route('/api/public/reseller', publicResellerRoutes);

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

/** GET /api/health/deps — Diagnostic des dépendances (admin). Alimente le panneau "Santé plateforme". */
app.get('/api/health/deps', authMiddleware, adminMiddleware, async (c) => {
  const db = createServiceClient();

  // ── Base de données : latence d'une requête simple ──────────────────────────
  let database: { ok: boolean; latency_ms: number; error?: string };
  const dbStart = Date.now();
  try {
    const { error } = await db.from('commerces').select('id', { head: true, count: 'exact' });
    database = error
      ? { ok: false, latency_ms: Date.now() - dbStart, error: error.message }
      : { ok: true, latency_ms: Date.now() - dbStart };
  } catch (e) {
    database = { ok: false, latency_ms: Date.now() - dbStart, error: e instanceof Error ? e.message : 'unknown' };
  }

  // ── Stripe : clé secrète configurée ─────────────────────────────────────────
  const stripeKey = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  const stripe = { ok: stripeKey.startsWith('sk_') };

  // ── Wallet : certificats Apple + compte de service Google ───────────────────
  const appleOk = Boolean(
    (process.env.APPLE_SIGNER_CERT_PEM ?? '').trim()
    && (process.env.APPLE_SIGNER_KEY_PEM ?? '').trim()
    && (process.env.APPLE_WWDR_PEM ?? '').trim()
    && (process.env.APPLE_PASS_TYPE_ID ?? '').trim(),
  );
  const googleOk = Boolean(
    ((process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim() || (process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? '').trim())
    && (process.env.GOOGLE_ISSUER_ID ?? '').trim(),
  );
  const wallet = { apple_ok: appleOk, google_ok: googleOk };

  // ── Migrations : présence des tables clés (une par époque de migration) ─────
  const tablesToCheck = ['commerces', 'points_vente', 'web_card_events', 'web_push_subscriptions', 'resellers', 'reseller_commissions'];
  const checks: Record<string, { ok: boolean }> = {};
  await Promise.all(
    tablesToCheck.map(async (table) => {
      const { error } = await db.from(table).select('*', { head: true, count: 'exact' }).limit(1);
      // 42P01 = relation inexistante → migration manquante
      checks[table] = { ok: !(error && error.code === '42P01') };
    }),
  );
  const migrations = { ok: Object.values(checks).every((entry) => entry.ok), checks };

  return c.json({ ok: true, services: { database, stripe, wallet, migrations } });
});

app.notFound((c) => c.json({ error: 'Route introuvable' }, 404));
app.onError((err, c) => {
  console.error('[API Error]', err);
  return c.json({ error: 'Erreur interne du serveur' }, 500);
});

const port = Number(process.env.PORT ?? 3001);
console.log(`API Fidelopass démarrée sur http://localhost:${port}`);

serve({ fetch: app.fetch, port });

const walletRefreshIntervalMs = Number(process.env.WALLET_REFRESH_INTERVAL_MS ?? 60_000);
const walletRefreshEnabled = process.env.WALLET_REFRESH_INTERVAL_ENABLED !== 'false';
let walletRefreshRunning = false;

if (walletRefreshEnabled && walletRefreshIntervalMs >= 30_000) {
  const runWalletRefresh = async () => {
    if (walletRefreshRunning) return;
    walletRefreshRunning = true;
    try {
      const db = createServiceClient();
      const lockTtlSeconds = Math.max(60, Math.ceil((walletRefreshIntervalMs / 1000) * 2));
      const lockResult = await withCronLock(db, 'wallet-refresh', lockTtlSeconds, () => refreshRecentlyChangedWallets(db));
      if (!lockResult.acquired || !lockResult.value) return;
      const result = lockResult.value;
      if (result.candidates > 0 || result.errors > 0) {
        console.log(
          `[wallet-refresh interval] candidats=${result.candidates}, google=${result.google_updated}, apple=${result.apple_pushed}, erreurs=${result.errors}`,
        );
      }
    } catch (error) {
      console.error('[wallet-refresh interval]', error);
    } finally {
      walletRefreshRunning = false;
    }
  };

  setInterval(runWalletRefresh, walletRefreshIntervalMs);
  setTimeout(runWalletRefresh, 10_000);
}
