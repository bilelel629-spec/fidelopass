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
import { createServiceClient } from '../src/lib/supabase';

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
  allowHeaders: ['Content-Type', 'Authorization', 'X-Point-Vente-Id'],
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

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));
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
      const result = await refreshRecentlyChangedWallets(createServiceClient());
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
