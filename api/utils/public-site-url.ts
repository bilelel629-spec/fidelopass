const FALLBACK_PUBLIC_SITE_URL = 'https://www.fidelopass.com';

function normalizeEnvValue(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.replace(/^['"]+|['"]+$/g, '').trim();
}

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
  const configuredPublic = normalizeEnvValue(process.env.PUBLIC_SITE_URL);
  const configuredApp = normalizeEnvValue(process.env.APP_URL);
  const raw = configuredPublic || configuredApp || FALLBACK_PUBLIC_SITE_URL;
  if (!raw) return FALLBACK_PUBLIC_SITE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return FALLBACK_PUBLIC_SITE_URL;
  }

  const nodeEnv = normalizeEnvValue(process.env.NODE_ENV).toLowerCase();
  const isProduction = nodeEnv === 'production';
  const allowLoopback = ['1', 'true', 'yes', 'on'].includes(
    normalizeEnvValue(process.env.ALLOW_LOOPBACK_PUBLIC_SITE_URL).toLowerCase(),
  );
  const onRailway = Boolean(
    process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.RAILWAY_ENVIRONMENT_NAME,
  );
  if (isLoopbackHostname(parsed.hostname) && !allowLoopback && (isProduction || onRailway || nodeEnv !== 'development')) {
    console.warn('[public-site-url] Loopback URL détectée. Fallback forcé vers https://www.fidelopass.com');
    return FALLBACK_PUBLIC_SITE_URL;
  }

  return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
}
