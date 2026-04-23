const CACHE_NAME = 'fidelopass-v10';
const APP_SHELL = [
  '/app',
  '/app/scan',
  '/app/install',
  '/favicon.png',
  '/manifest.json',
];

const STATIC_ASSET_REGEX = /\.(?:js|mjs|css|png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)$/i;

function isDashboardLikePath(pathname) {
  return (
    pathname.startsWith('/dashboard')
    || pathname.startsWith('/carte/')
    || pathname.startsWith('/login')
    || pathname.startsWith('/register')
    || pathname.startsWith('/abonnement')
    || pathname.startsWith('/onboarding')
    || pathname.startsWith('/admin')
  );
}

// ── Installation : mise en cache de l'app shell ──────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activation : nettoyage des anciens caches ────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch : évite le cache agressif des pages dynamiques, garde le cache pour assets ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Les appels API ne sont jamais mis en cache
  if (url.pathname.startsWith('/api/')) {
    return; // laisse passer sans interception
  }

  if (request.mode === 'navigate') {
    // Pour les pages dynamiques, toujours préférer le réseau (évite les pages obsolètes).
    if (isDashboardLikePath(url.pathname)) {
      event.respondWith(fetch(request));
      return;
    }

    // Pour l'app scanner, fallback offline basique si réseau indisponible.
    if (url.pathname.startsWith('/app')) {
      event.respondWith(
        fetch(request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return response;
          })
          .catch(async () => {
            const cached = await caches.match(request);
            if (cached) return cached;
            return caches.match('/app');
          })
      );
      return;
    }

    event.respondWith(fetch(request));
    return;
  }

  if (!STATIC_ASSET_REGEX.test(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached ?? new Response('Offline', { status: 503 }));

      return cached ?? networkPromise;
    }),
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'Fidelopass', body: 'Nouvelle notification', icon: '/favicon.png' };
  try {
    if (event.data) {
      const data = event.data.json();
      payload = {
        ...payload,
        ...data.data,
        ...data.notification,
        ...data,
        title: data.notification?.title ?? data.data?.title ?? data.title ?? payload.title,
        body: data.notification?.body ?? data.data?.body ?? data.body ?? payload.body,
        icon: data.notification?.icon ?? data.data?.icon ?? data.icon ?? payload.icon,
      };
    }
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon ?? '/favicon.png',
      badge: '/favicon.png',
      tag: 'fidelopass-promo',
      renotify: true,
      data: { url: '/' },
    })
  );
});

// ── Clic sur notification ─────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((c) => c.url === target && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
