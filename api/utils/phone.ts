import { createHmac } from 'node:crypto';

/** Normalise les mobiles francais et les numeros deja fournis en E.164. */
export function normalizePhoneE164(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  if (/^0[67][0-9]{8}$/.test(digits)) return `+33${digits.slice(1)}`;
  if (/^33[67][0-9]{8}$/.test(digits)) return `+${digits}`;
  if (raw.startsWith('+') && /^[1-9][0-9]{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

export function maskPhone(value: string): string {
  if (value.length < 6) return '***';
  return `${value.slice(0, 4)} •• •• ${value.slice(-2)}`;
}

export function normalizeOrigin(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function requestIp(headers: { get(name: string): string | undefined }): string {
  return (headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
    || headers.get('x-real-ip')
    || 'unknown';
}

export function hmacIdentifier(secret: string, namespace: string, value: string): string {
  return createHmac('sha256', secret).update(`${namespace}:${value}`).digest('hex');
}
