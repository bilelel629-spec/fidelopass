const FALLBACK_PUBLIC_SITE_URL = 'https://www.fidelopass.com';

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return (
    value === 'localhost'
    || value === '127.0.0.1'
    || value === '0.0.0.0'
    || value.endsWith('.localhost')
  );
}

export function getPublicSiteUrl(): string {
  const raw = (process.env.PUBLIC_SITE_URL ?? process.env.APP_URL ?? FALLBACK_PUBLIC_SITE_URL).trim();
  if (!raw) return FALLBACK_PUBLIC_SITE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return FALLBACK_PUBLIC_SITE_URL;
  }

  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase();
  const isProduction = nodeEnv === 'production';
  if (isProduction && isLoopbackHostname(parsed.hostname)) {
    return FALLBACK_PUBLIC_SITE_URL;
  }

  return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
}

