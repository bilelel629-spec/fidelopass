import { defineMiddleware } from 'astro:middleware';

const PROTECTED_PREFIXES = ['/dashboard', '/admin', '/onboarding', '/app'];

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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

export const onRequest = defineMiddleware(async (context, next) => {
  const startedAt = Date.now();
  const withSecurityHeaders = (response: Response) => {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
    response.headers.set('X-Response-Time', `${Date.now() - startedAt}ms`);
    if (context.url.protocol === 'https:') {
      response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    return response;
  };

  const pathname = context.url.pathname;
  if (!isProtectedPath(pathname)) {
    return withSecurityHeaders(await next());
  }

  const token = getSessionTokenFromCookie(context.request.headers.get('cookie'));
  if (!token) {
    return withSecurityHeaders(Response.redirect(new URL('/login', context.url), 302));
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
      return withSecurityHeaders(redirectWithCookieClear(new URL('/login', context.url), context.url));
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
      if (pathname.startsWith('/dashboard') || pathname === '/onboarding') {
        return withSecurityHeaders(Response.redirect(new URL('/abonnement/choix', context.url), 302));
      }
      return withSecurityHeaders(await next());
    }

    if (pathname.startsWith('/dashboard') && !billing?.onboarding_completed) {
      return withSecurityHeaders(Response.redirect(new URL('/onboarding', context.url), 302));
    }

    if (pathname === '/onboarding' && billing?.onboarding_completed) {
      return withSecurityHeaders(Response.redirect(new URL('/dashboard', context.url), 302));
    }
  } catch {
    // En cas de timeout/réseau, on laisse passer et on délègue le contrôle d'accès aux APIs protégées.
    return withSecurityHeaders(await next());
  }

  return withSecurityHeaders(await next());
});
