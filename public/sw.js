const CACHE_NAME = 'fidelipass-v1';
const APP_SHELL = [
  '/app',
  '/app/scan',
  '/favicon.svg',
  '/manifest.json',
];

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

// ── Fetch : cache-first pour l'app shell, network-first pour l'API ───────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Les appels API ne sont jamais mis en cache
  if (url.pathname.startsWith('/api/')) {
    return; // laisse passer sans interception
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Met en cache uniquement les ressources GET du même domaine
        if (request.method === 'GET' && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached ?? new Response('Offline', { status: 503 }));
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'FidéliPass', body: 'Nouvelle notification', icon: '/favicon.svg' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon ?? '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'fidelipass-promo',
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
