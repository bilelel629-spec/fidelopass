import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ApiEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { generateApplePass } from '../services/apple-wallet';
import { generateGooglePass } from '../services/google-wallet';
import { getPointRewardState } from '../services/point-rewards';
import {
  generateOtpCode,
  generateWidgetSessionToken,
  getWidgetAuthSecret,
  hashOtp,
  hashWidgetSessionToken,
  verifyOtpHash,
  WIDGET_MAX_OTP_ATTEMPTS,
  WIDGET_OTP_TTL_MS,
  WIDGET_SESSION_TTL_MS,
  widgetFeatureEnabled,
} from '../services/widget-auth';
import { sendWidgetOtpSms } from '../services/widget-sms';
import { resolveCommerceAccess } from '../utils/commerce-access';
import { hmacIdentifier, maskPhone, normalizeOrigin, normalizePhoneE164 } from '../utils/phone';
import { createServiceClient } from '../../src/lib/supabase';

export const widgetRoutes = new Hono<ApiEnv>();

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL ?? 'https://www.fidelopass.com').replace(/\/$/, '');
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? 'https://api.fidelopass.com').replace(/\/$/, '');
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PHONE = 5;
const RATE_LIMIT_IP = 20;
const RESEND_COOLDOWN_MS = 60 * 1000;

type WidgetConfig = {
  id: string;
  commerce_id: string;
  public_key: string;
  enabled: boolean;
  allowed_origins: string[];
  portal_url: string | null;
  theme: Record<string, unknown> | null;
  display_options: Record<string, unknown> | null;
  commerces?: { id?: string; nom?: string | null; logo_url?: string | null } | Array<{ id?: string; nom?: string | null; logo_url?: string | null }> | null;
};

const publicKeySchema = z.string().regex(/^wgt_[a-zA-Z0-9_-]{16,80}$/);
const requestCodeSchema = z.object({
  phone: z.string().min(8).max(30),
  turnstile_token: z.string().max(4096).optional(),
});
const verifyCodeSchema = z.object({
  challenge_id: z.string().uuid(),
  phone: z.string().min(8).max(30),
  code: z.string().regex(/^\d{6}$/),
});
const adminConfigSchema = z.object({
  enabled: z.boolean(),
  allowed_origins: z.array(z.string().max(300)).max(10),
  portal_url: z.string().max(500).nullable().optional(),
  theme: z.object({
    title: z.string().max(80).optional(),
    primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    logo_url: z.string().url().max(500).nullable().optional(),
  }).default({}),
  display_options: z.object({
    show_history: z.boolean().default(true),
    show_wallet_links: z.boolean().default(true),
  }).default({ show_history: true, show_wallet_links: true }),
});

function commerceFrom(config: WidgetConfig) {
  return Array.isArray(config.commerces) ? config.commerces[0] : config.commerces;
}

function getOrigin(c: Context): string | null {
  return normalizeOrigin(c.req.header('origin'));
}

function getRequestIp(c: Context): string {
  return (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim()
    || c.req.header('x-real-ip')
    || 'unknown';
}

function withWidgetCors(c: Context, origin: string | null) {
  if (!origin) return;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function loadConfig(db: SupabaseClient, publicKey: string): Promise<WidgetConfig | null> {
  const { data, error } = await db
    .from('widget_configs')
    .select('*, commerces(id, nom, logo_url)')
    .eq('public_key', publicKey)
    .maybeSingle();
  if (error) throw error;
  return data as WidgetConfig | null;
}

function originAllowed(config: WidgetConfig, origin: string | null): boolean {
  if (!origin) return process.env.NODE_ENV !== 'production';
  return (config.allowed_origins ?? []).some((allowed) => normalizeOrigin(allowed) === origin);
}

async function requirePublicConfig(c: Context, publicKey: string) {
  if (!widgetFeatureEnabled()) return { response: c.json({ error: 'Widget indisponible' }, 503) };
  if (!publicKeySchema.safeParse(publicKey).success) return { response: c.json({ error: 'Widget introuvable' }, 404) };

  const db = createServiceClient();
  const config = await loadConfig(db, publicKey);
  if (!config?.enabled) return { response: c.json({ error: 'Widget introuvable' }, 404) };

  const origin = getOrigin(c);
  if (!originAllowed(config, origin)) return { response: c.json({ error: 'Origine non autorisée' }, 403) };
  withWidgetCors(c, origin);
  return { db, config, origin };
}

function serializeAdminConfig(config: WidgetConfig) {
  const snippet = `<script src="${PUBLIC_SITE_URL}/widget/v1/client.js" defer></script>\n<fidelopass-loyalty program="${config.public_key}" api-url="${PUBLIC_API_URL}"></fidelopass-loyalty>`;
  return {
    id: config.id,
    public_key: config.public_key,
    enabled: config.enabled,
    runtime_enabled: widgetFeatureEnabled(),
    allowed_origins: config.allowed_origins ?? [],
    portal_url: config.portal_url,
    theme: config.theme ?? {},
    display_options: config.display_options ?? {},
    snippet,
  };
}

async function getOrCreateAdminConfig(db: SupabaseClient, commerceId: string): Promise<WidgetConfig> {
  const current = await db.from('widget_configs').select('*').eq('commerce_id', commerceId).maybeSingle();
  if (current.error) throw current.error;
  if (current.data) return current.data as WidgetConfig;

  const created = await db.from('widget_configs').insert({ commerce_id: commerceId }).select('*').single();
  if (created.error || !created.data) throw created.error ?? new Error('Configuration widget non créée');
  return created.data as WidgetConfig;
}

widgetRoutes.get('/admin/config', authMiddleware, paidMiddleware, async (c) => {
  const db = createServiceClient();
  const access = await resolveCommerceAccess(db, c.get('userId'));
  if (!access) return c.json({ error: 'Commerce introuvable' }, 404);
  if (access.role === 'staff') return c.json({ error: 'Droits administrateur requis' }, 403);
  const config = await getOrCreateAdminConfig(db, access.commerceId);
  return c.json({ data: serializeAdminConfig(config) });
});

widgetRoutes.put('/admin/config', authMiddleware, paidMiddleware, async (c) => {
  const parsed = adminConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.errors[0]?.message ?? 'Configuration invalide' }, 400);

  const allowedOrigins = Array.from(new Set(parsed.data.allowed_origins.map(normalizeOrigin).filter((value): value is string => Boolean(value))));
  if (parsed.data.enabled && allowedOrigins.length === 0) {
    return c.json({ error: 'Ajoutez au moins un domaine autorisé avant d’activer le widget.' }, 400);
  }
  if (allowedOrigins.length !== parsed.data.allowed_origins.length) {
    return c.json({ error: 'Un domaine autorisé est invalide. Utilisez une adresse HTTPS sans chemin.' }, 400);
  }

  const portalUrlRaw = parsed.data.portal_url?.trim() || null;
  let portalUrl: string | null = null;
  if (portalUrlRaw) {
    try {
      const url = new URL(portalUrlRaw);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
      portalUrl = url.toString();
    } catch {
      return c.json({ error: 'L’URL de l’espace fidélité doit être une adresse HTTPS valide.' }, 400);
    }
  }

  const db = createServiceClient();
  const access = await resolveCommerceAccess(db, c.get('userId'));
  if (!access) return c.json({ error: 'Commerce introuvable' }, 404);
  if (access.role === 'staff') return c.json({ error: 'Droits administrateur requis' }, 403);
  const current = await getOrCreateAdminConfig(db, access.commerceId);

  const updated = await db
    .from('widget_configs')
    .update({
      enabled: parsed.data.enabled,
      allowed_origins: allowedOrigins,
      portal_url: portalUrl,
      theme: parsed.data.theme,
      display_options: parsed.data.display_options,
    })
    .eq('id', current.id)
    .select('*')
    .single();
  if (updated.error || !updated.data) return c.json({ error: 'Impossible d’enregistrer le widget' }, 500);

  if (current.portal_url !== portalUrl || current.enabled !== parsed.data.enabled) {
    await db.from('cartes').update({ updated_at: new Date().toISOString() }).eq('commerce_id', access.commerceId);
  }

  return c.json({ data: serializeAdminConfig(updated.data as WidgetConfig) });
});

widgetRoutes.options('/:publicKey/*', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  withWidgetCors(c, result.origin);
  return c.body(null, 204);
});

widgetRoutes.get('/:publicKey/config', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const merchant = commerceFrom(result.config);
  return c.json({
    data: {
      public_key: result.config.public_key,
      merchant: {
        name: merchant?.nom ?? 'Programme fidélité',
        logo_url: result.config.theme?.logo_url ?? merchant?.logo_url ?? null,
      },
      theme: result.config.theme ?? {},
      display_options: result.config.display_options ?? {},
    },
  });
});

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = (process.env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const payload = await response.json().catch(() => ({})) as { success?: boolean };
  return response.ok && payload.success === true;
}

widgetRoutes.post('/:publicKey/auth/request-code', async (c) => {
  const startedAt = Date.now();
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;

  const parsed = requestCodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Numéro de téléphone invalide' }, 400);
  const phone = normalizePhoneE164(parsed.data.phone);
  if (!phone) return c.json({ error: 'Saisissez un numéro mobile valide.' }, 400);

  const ip = getRequestIp(c);
  if (!await verifyTurnstile(parsed.data.turnstile_token, ip)) {
    return c.json({ error: 'Vérification anti-robot impossible. Réessayez.' }, 400);
  }

  const secret = getWidgetAuthSecret();
  const phoneHash = hmacIdentifier(secret, 'widget-phone', phone);
  const ipHash = hmacIdentifier(secret, 'widget-ip', ip);
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const cooldownStart = new Date(Date.now() - RESEND_COOLDOWN_MS).toISOString();
  const [phoneCount, ipCount, recent] = await Promise.all([
    result.db.from('widget_auth_challenges').select('id', { count: 'exact', head: true }).eq('widget_config_id', result.config.id).eq('phone_hash', phoneHash).gte('created_at', windowStart),
    result.db.from('widget_auth_challenges').select('id', { count: 'exact', head: true }).eq('widget_config_id', result.config.id).eq('ip_hash', ipHash).gte('created_at', windowStart),
    result.db.from('widget_auth_challenges').select('id').eq('widget_config_id', result.config.id).eq('phone_hash', phoneHash).gte('created_at', cooldownStart).limit(1),
  ]);
  if ((phoneCount.count ?? 0) >= RATE_LIMIT_PHONE || (ipCount.count ?? 0) >= RATE_LIMIT_IP) {
    return c.json({ error: 'Trop de tentatives. Réessayez dans une heure.' }, 429);
  }
  if ((recent.data ?? []).length > 0) return c.json({ error: 'Patientez une minute avant de demander un nouveau code.' }, 429);

  const membership = await result.db
    .from('clients')
    .select('id, cartes!inner(id, actif)')
    .eq('commerce_id', result.config.commerce_id)
    .eq('telephone_e164', phone)
    .eq('cartes.actif', true)
    .limit(1);
  if (membership.error) throw membership.error;

  const challengeId = randomUUID();
  const otp = generateOtpCode();
  const memberExists = (membership.data ?? []).length > 0;
  const expiresAt = new Date(Date.now() + WIDGET_OTP_TTL_MS).toISOString();
  const challenge = await result.db.from('widget_auth_challenges').insert({
    id: challengeId,
    widget_config_id: result.config.id,
    phone_e164: phone,
    phone_hash: phoneHash,
    ip_hash: ipHash,
    otp_hash: hashOtp(secret, challengeId, phone, otp),
    delivery_status: memberExists ? 'pending' : 'ignored',
    expires_at: expiresAt,
  });
  if (challenge.error) throw challenge.error;

  if (memberExists) {
    const sms = await sendWidgetOtpSms(phone, otp);
    await result.db.from('widget_auth_challenges').update({ delivery_status: sms.ok ? 'sent' : 'failed' }).eq('id', challengeId);
  }

  const remainingDelay = 350 - (Date.now() - startedAt);
  if (remainingDelay > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelay));
  return c.json({
    data: {
      challenge_id: challengeId,
      masked_phone: maskPhone(phone),
      expires_in: Math.floor(WIDGET_OTP_TTL_MS / 1000),
      resend_after: Math.floor(RESEND_COOLDOWN_MS / 1000),
      message: 'Si ce numéro correspond à une carte active, un code vient d’être envoyé par SMS.',
    },
  });
});

widgetRoutes.post('/:publicKey/auth/verify-code', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const parsed = verifyCodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Code invalide' }, 400);
  const phone = normalizePhoneE164(parsed.data.phone);
  if (!phone) return c.json({ error: 'Code invalide ou expiré' }, 400);

  const challengeResult = await result.db
    .from('widget_auth_challenges')
    .select('*')
    .eq('id', parsed.data.challenge_id)
    .eq('widget_config_id', result.config.id)
    .maybeSingle();
  const challenge = challengeResult.data;
  if (!challenge || challenge.consumed_at || challenge.phone_e164 !== phone || new Date(challenge.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'Code invalide ou expiré' }, 400);
  }
  if ((challenge.attempts ?? 0) >= WIDGET_MAX_OTP_ATTEMPTS) return c.json({ error: 'Code bloqué. Demandez-en un nouveau.' }, 429);

  const nextAttempts = (challenge.attempts ?? 0) + 1;
  const expected = hashOtp(getWidgetAuthSecret(), challenge.id, phone, parsed.data.code);
  const valid = Boolean(challenge.otp_hash) && challenge.delivery_status === 'sent' && verifyOtpHash(challenge.otp_hash, expected);
  if (!valid) {
    await result.db.from('widget_auth_challenges').update({ attempts: nextAttempts }).eq('id', challenge.id);
    return c.json({ error: nextAttempts >= WIDGET_MAX_OTP_ATTEMPTS ? 'Code bloqué. Demandez-en un nouveau.' : 'Code incorrect.' }, nextAttempts >= WIDGET_MAX_OTP_ATTEMPTS ? 429 : 400);
  }

  const membership = await result.db
    .from('clients')
    .select('id, cartes!inner(id, actif)')
    .eq('commerce_id', result.config.commerce_id)
    .eq('telephone_e164', phone)
    .eq('cartes.actif', true)
    .limit(1);
  if (membership.error || (membership.data ?? []).length === 0) return c.json({ error: 'Carte fidélité introuvable.' }, 404);

  const now = new Date().toISOString();
  const consumed = await result.db
    .from('widget_auth_challenges')
    .update({ attempts: nextAttempts, consumed_at: now })
    .eq('id', challenge.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();
  if (consumed.error || !consumed.data) return c.json({ error: 'Code déjà utilisé. Demandez-en un nouveau.' }, 409);
  const token = generateWidgetSessionToken();
  const expiresAt = new Date(Date.now() + WIDGET_SESSION_TTL_MS).toISOString();
  const session = await result.db.from('widget_sessions').insert({
    widget_config_id: result.config.id,
    phone_e164: phone,
    token_hash: hashWidgetSessionToken(getWidgetAuthSecret(), token),
    expires_at: expiresAt,
  });
  if (session.error) throw session.error;
  return c.json({ data: { access_token: token, expires_at: expiresAt } });
});

async function requireWidgetSession(c: Context, db: SupabaseClient, config: WidgetConfig) {
  const authorization = c.req.header('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token.length > 200) return null;
  const tokenHash = hashWidgetSessionToken(getWidgetAuthSecret(), token);
  const { data, error } = await db
    .from('widget_sessions')
    .select('*')
    .eq('widget_config_id', config.id)
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  await db.from('widget_sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  return data as { id: string; phone_e164: string };
}

async function loadOwnedClient(db: SupabaseClient, config: WidgetConfig, phone: string, clientId: string) {
  const { data, error } = await db
    .from('clients')
    .select('*, cartes!inner(*, commerces(id, nom, logo_url, latitude, longitude, rayon_geo, plan), points_vente(id, nom, adresse, latitude, longitude, rayon_geo))')
    .eq('id', clientId)
    .eq('commerce_id', config.commerce_id)
    .eq('telephone_e164', phone)
    .eq('cartes.actif', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

widgetRoutes.get('/:publicKey/me', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const session = await requireWidgetSession(c, result.db, result.config);
  if (!session) return c.json({ error: 'Session expirée' }, 401);

  const clientsResult = await result.db
    .from('clients')
    .select('id, nom, carte_id, point_vente_id, points_actuels, tampons_actuels, recompenses_obtenues, derniere_visite, cartes!inner(id, nom, type, actif, tampons_total, points_recompense, recompense_description, rewards_multi_enabled, rewards_config), points_vente(id, nom)')
    .eq('commerce_id', result.config.commerce_id)
    .eq('telephone_e164', session.phone_e164)
    .eq('cartes.actif', true)
    .order('created_at', { ascending: true });
  if (clientsResult.error) throw clientsResult.error;

  const clients = clientsResult.data ?? [];
  const clientIds = clients.map((client) => client.id);
  const transactionsResult = clientIds.length > 0
    ? await result.db.from('transactions').select('id, client_id, type, valeur, points_avant, points_apres, note, created_at').in('client_id', clientIds).eq('commerce_id', result.config.commerce_id).order('created_at', { ascending: false }).limit(30)
    : { data: [], error: null };
  if (transactionsResult.error) throw transactionsResult.error;

  const historyByClient = new Map<string, unknown[]>();
  for (const transaction of transactionsResult.data ?? []) {
    const current = historyByClient.get(transaction.client_id) ?? [];
    current.push({
      id: transaction.id,
      type: transaction.type,
      value: transaction.valeur,
      before: transaction.points_avant,
      after: transaction.points_apres,
      note: transaction.note,
      date: transaction.created_at,
    });
    historyByClient.set(transaction.client_id, current);
  }

  const apiOrigin = new URL(c.req.url).origin;
  const programs = clients.map((client) => {
    const card = Array.isArray(client.cartes) ? client.cartes[0] : client.cartes;
    const pointVente = Array.isArray(client.points_vente) ? client.points_vente[0] : client.points_vente;
    return {
      membership_id: client.id,
      card_id: client.carte_id,
      card_name: card?.nom ?? 'Carte fidélité',
      location_name: pointVente?.nom ?? null,
      type: card?.type,
      points: client.points_actuels ?? 0,
      stamps: client.tampons_actuels ?? 0,
      stamps_total: card?.tampons_total ?? 10,
      rewards_earned: client.recompenses_obtenues ?? 0,
      reward_state: card?.type === 'points' ? getPointRewardState(client.points_actuels, card) : null,
      last_visit: client.derniere_visite,
      history: historyByClient.get(client.id) ?? [],
      wallet: {
        apple_url: `${apiOrigin}/api/widget/${result.config.public_key}/wallet/apple/${client.id}`,
        google_url: `${apiOrigin}/api/widget/${result.config.public_key}/wallet/google/${client.id}`,
      },
    };
  });

  return c.json({
    data: {
      customer: { first_name: clients[0]?.nom ?? 'Client' },
      programs,
      portal_url: result.config.portal_url,
    },
  });
});

widgetRoutes.post('/:publicKey/logout', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const session = await requireWidgetSession(c, result.db, result.config);
  if (session) await result.db.from('widget_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', session.id);
  return c.json({ ok: true });
});

widgetRoutes.get('/:publicKey/wallet/apple/:clientId', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const session = await requireWidgetSession(c, result.db, result.config);
  if (!session) return c.json({ error: 'Session expirée' }, 401);
  const client = await loadOwnedClient(result.db, result.config, session.phone_e164, c.req.param('clientId') ?? '');
  if (!client) return c.json({ error: 'Carte introuvable' }, 404);
  const card = Array.isArray(client.cartes) ? client.cartes[0] : client.cartes;
  const pass = await generateApplePass(card as Parameters<typeof generateApplePass>[0], client);
  await result.db.from('clients').update({ apple_pass_serial: client.id }).eq('id', client.id);
  return new Response(new Uint8Array(pass), {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="fidelite.pkpass"',
      'Cache-Control': 'no-store',
    },
  });
});

widgetRoutes.post('/:publicKey/wallet/google/:clientId', async (c) => {
  const result = await requirePublicConfig(c, c.req.param('publicKey') ?? '');
  if ('response' in result) return result.response;
  const session = await requireWidgetSession(c, result.db, result.config);
  if (!session) return c.json({ error: 'Session expirée' }, 401);
  const client = await loadOwnedClient(result.db, result.config, session.phone_e164, c.req.param('clientId') ?? '');
  if (!client) return c.json({ error: 'Carte introuvable' }, 404);
  const card = Array.isArray(client.cartes) ? client.cartes[0] : client.cartes;
  const { objectId, saveUrl } = await generateGooglePass(card as Parameters<typeof generateGooglePass>[0], client);
  await result.db.from('clients').update({ google_pass_id: objectId }).eq('id', client.id);
  return c.json({ data: { save_url: saveUrl } });
});
