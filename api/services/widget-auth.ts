import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const WIDGET_OTP_TTL_MS = 10 * 60 * 1000;
export const WIDGET_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const WIDGET_MAX_OTP_ATTEMPTS = 5;

export function widgetFeatureEnabled(): boolean {
  return process.env.CUSTOMER_WIDGET_ENABLED === 'true';
}

export function getWidgetAuthSecret(): string {
  const secret = (process.env.WIDGET_AUTH_SECRET ?? '').trim();
  if (secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== 'production') return 'dev-only-widget-secret-change-before-production';
  throw new Error('WIDGET_AUTH_SECRET doit contenir au moins 32 caracteres');
}

function digest(secret: string, namespace: string, value: string): string {
  return createHmac('sha256', secret).update(`${namespace}:${value}`).digest('hex');
}

export function generateOtpCode(): string {
  return String(randomInt(100000, 1_000_000));
}

export function hashOtp(secret: string, challengeId: string, phone: string, otp: string): string {
  return digest(secret, 'widget-otp', `${challengeId}:${phone}:${otp}`);
}

export function verifyOtpHash(expectedHex: string, actualHex: string): boolean {
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateWidgetSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashWidgetSessionToken(secret: string, token: string): string {
  return digest(secret, 'widget-session', token);
}
