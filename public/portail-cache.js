const CACHE = 'portail-static-v1';
const STATIC_EXT = /\.(?:css|js|webp|jpg|jpeg|png|svg|ico|woff2?)$/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (!STATIC_EXT.test(url.pathname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refresh = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || refresh;
  })());
});
