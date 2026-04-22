const CACHE_NAME = 'cosampa-v1';
const ASSETS = [
  '/cosampa-app/',
  '/cosampa-app/index.html',
  '/cosampa-app/icon-192.png',
  '/cosampa-app/icon-512.png',
  '/cosampa-app/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Para requisições da planilha e CSVs, sempre tenta rede primeiro
  if (e.request.url.includes('google') || e.request.url.includes('githubusercontent')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Para assets do app, cache primeiro
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      return resp;
    }))
  );
});
