const CACHE_NAME = 'fidelopass-v11';
const APP_SHELL = [
  '/app',
  '/app/scan',
  '/favicon.png',
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

// ── Fetch : network-first pour éviter de garder une vieille version après deploy ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Les appels API ne sont jamais mis en cache
  if (url.pathname.startsWith('/api/')) {
    return; // laisse passer sans interception
  }

  event.respondWith(
    fetch(request).then((response) => {
      if (request.method === 'GET' && url.origin === self.location.origin) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }).catch(() =>
      caches.match(request).then((cached) => cached ?? new Response('Offline', { status: 503 }))
    )
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
// FCM envoie des messages "data-only" (sans clé notification) pour que le push
// event soit TOUJOURS déclenché par le service worker. Si notification était
// présente, FCM pouvait l'afficher lui-même et bypasser ce handler → intermittent.
self.addEventListener('push', (event) => {
  let title = 'Fidelopass';
  let body = 'Nouvelle notification';
  let icon = '/favicon.png';
  let url = '/';

  try {
    if (event.data) {
      const raw = event.data.json();
      // Les données FCM sont dans raw.data (message data-only)
      const d = raw.data ?? raw;
      title = d.title ?? title;
      body = d.body ?? body;
      icon = d.icon || '/favicon.png';
      url = d.url ?? '/';
    }
  } catch {
    if (event.data) body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: '/favicon.png',
      tag: 'fidelopass-' + Date.now(),
      renotify: false,
      data: { url },
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
