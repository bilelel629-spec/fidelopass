import 'dotenv/config';
import { Hono } from 'hono';
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

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
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

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));
app.notFound((c) => c.json({ error: 'Route introuvable' }, 404));
app.onError((err, c) => {
  console.error('[API Error]', err);
  return c.json({ error: 'Erreur interne du serveur' }, 500);
});

const port = Number(process.env.PORT ?? 3001);
console.log(`API FideloPass démarrée sur http://localhost:${port}`);

serve({ fetch: app.fetch, port });
