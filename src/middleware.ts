import { defineMiddleware } from 'astro:middleware';

const PROTECTED_PREFIXES = ['/dashboard', '/admin', '/onboarding', '/app', '/partner'];
const BILLING_GATE_PREFIXES = ['/abonnement/choix', '/abonnement/setup'];

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isBillingGatePath(pathname: string) {
  return BILLING_GATE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function getSessionTokenFromCookie(cookieHeader: string | null) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((part) => part.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith('fp_session=')) {
      const [, rawToken] = cookie.split('=');
      return rawToken ? decodeURIComponent(rawToken) : null;
    }
  }
  return null;
}

function redirectWithCookieClear(target: URL, requestUrl: URL) {
  const headers = new Headers({ Location: target.toString() });
  const securePart = requestUrl.protocol === 'https:' ? '; Secure' : '';
  headers.append('Set-Cookie', `fp_session=; Path=/; Max-Age=0; SameSite=Lax${securePart}`);
  return new Response(null, { status: 302, headers });
}

function normalizeConfiguredSiteUrl(value: string | undefined): string {
  const cleaned = (value ?? '').trim().replace(/^['"]+|['"]+$/g, '');
  return cleaned.replace(/\/$/, '');
}

function isLoopbackHost(value: string): boolean {
  const hostname = value.split(':')[0].trim().toLowerCase();
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname.endsWith('.localhost')
  );
}

function resolveExternalOrigin(context: Parameters<typeof defineMiddleware>[0] extends (ctx: infer T, ...args: any[]) => any ? T : never): string {
  const request = context.request;
  const forwardedHost = (request.headers.get('x-forwarded-host') ?? '').split(',')[0].trim();
  const host = (forwardedHost || request.headers.get('host') || context.url.host || '').trim();
  const forwardedProto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || context.url.protocol.replace(':', '') || 'https';

  if (host && !isLoopbackHost(host)) {
    return `${protocol}://${host}`;
  }

  return (
    normalizeConfiguredSiteUrl(import.meta.env.PUBLIC_SITE_URL)
    || normalizeConfiguredSiteUrl(process.env.PUBLIC_SITE_URL)
    || normalizeConfiguredSiteUrl(process.env.APP_URL)
    || 'https://www.fidelopass.com'
  );
}

function buildExternalRedirectUrl(context: Parameters<typeof defineMiddleware>[0] extends (ctx: infer T, ...args: any[]) => any ? T : never, pathname: string): URL {
  return new URL(pathname, `${resolveExternalOrigin(context).replace(/\/$/, '')}/`);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = Date.now();
  const withSecurityHeaders = (response: Response) => {
    // Certaines réponses Astro exposent des headers immuables.
    // On recrée toujours une Response avec headers mutables avant d'ajouter nos entêtes sécurité.
    const secured = new Response(response.body, response);

    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('X-Frame-Options', 'DENY');
    secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    secured.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
    secured.headers.set('X-Response-Time', `${Date.now() - startedAt}ms`);
    if (context.url.protocol === 'https:') {
      secured.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    return secured;
  };

  const pathname = context.url.pathname;
  const isProtected = isProtectedPath(pathname);
  const isBillingGate = isBillingGatePath(pathname);

  if (!isProtected && !isBillingGate) {
    return withSecurityHeaders(await next());
  }

  const token = getSessionTokenFromCookie(context.request.headers.get('cookie'));
  if (!token) {
    if (isBillingGate) {
      return withSecurityHeaders(Response.redirect(buildExternalRedirectUrl(context, '/register'), 302));
    }
    const loginUrl = buildExternalRedirectUrl(context, '/login');
    loginUrl.searchParams.set('next', `${context.url.pathname}${context.url.search}`);
    return withSecurityHeaders(Response.redirect(loginUrl, 302));
  }

  const apiBase = (import.meta.env.PUBLIC_API_URL ?? process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
  if (!apiBase) {
    return withSecurityHeaders(await next());
  }

  try {
    const timeoutMs = Number(import.meta.env.BILLING_GUARD_TIMEOUT_MS ?? process.env.BILLING_GUARD_TIMEOUT_MS ?? 4200);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const billingResponse = await fetch(`${apiBase}/api/billing/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (billingResponse.status === 401) {
      return withSecurityHeaders(redirectWithCookieClear(
        buildExternalRedirectUrl(context, isBillingGate ? '/register' : '/login'),
        context.url,
      ));
    }

    if (!billingResponse.ok) {
      // On n'applique pas de redirection de paiement sur incident serveur/transitoire.
      // Les routes API sensibles restent protégées côté backend via paidMiddleware.
      if (billingResponse.status >= 500) {
        return withSecurityHeaders(await next());
      }
      return withSecurityHeaders(await next());
    }

    const billingPayload = await billingResponse.json().catch(() => null);
    const billing = billingPayload?.data;
    if (!billing) {
      return withSecurityHeaders(await next());
    }

    if (!billing?.has_access) {
      if (isBillingGate) {
        return withSecurityHeaders(await next());
      }
      if (pathname.startsWith('/dashboard') || pathname === '/onboarding') {
        return withSecurityHeaders(Response.redirect(buildExternalRedirectUrl(context, '/abonnement/choix'), 302));
      }
      return withSecurityHeaders(await next());
    }

    if (pathname.startsWith('/dashboard') && !billing?.onboarding_completed) {
      return withSecurityHeaders(Response.redirect(buildExternalRedirectUrl(context, '/onboarding'), 302));
    }

    if (pathname === '/onboarding' && billing?.onboarding_completed) {
      return withSecurityHeaders(Response.redirect(buildExternalRedirectUrl(context, '/dashboard'), 302));
    }

    if (isBillingGate) {
      return withSecurityHeaders(Response.redirect(
        buildExternalRedirectUrl(context, billing?.onboarding_completed ? '/dashboard' : '/onboarding'),
        302,
      ));
    }
  } catch {
    // En cas de timeout/réseau, on laisse passer et on délègue le contrôle d'accès aux APIs protégées.
    return withSecurityHeaders(await next());
  }

  return withSecurityHeaders(await next());
});
