// Mkass service worker: push notifications + light PWA app-shell cache
const MKASS_CACHE = 'mkass-app-shell-v1';
const MKASS_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(MKASS_CACHE)
      .then((cache) => cache.addAll(MKASS_ASSETS).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => key !== MKASS_CACHE ? caches.delete(key) : null)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API calls; keep reservation data live.
  if (url.pathname.startsWith('/api/') || url.hostname.includes('railway.app')) return;

  // Navigation: network first, cached fallback if offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(MKASS_CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => null);
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static files: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res && res.ok) caches.open(MKASS_CACHE).then((cache) => cache.put(req, res.clone())).catch(() => null);
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'Mkass';
  const options = {
    body: data.body || 'Nouvelle notification',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: data.data || { url: '/' },
    requireInteraction: false,
  };

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      client.postMessage({ type: 'MKASS_PUSH_NOTIFICATION', title, body: options.body, data: options.data });
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return null;
    })
  );
});
