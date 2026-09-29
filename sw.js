// Aumente a versão sempre que mudar a lista de ASSETS ou a estratégia de cache.
const CACHE_NAME = 'cosampa-v2';
const DATA_CACHE = 'cosampa-data-v1';
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
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== DATA_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Rede primeiro; guarda a resposta boa e cai pro cache se estiver offline.
function networkFirst(request, cacheName) {
  return fetch(request).then(resp => {
    if (resp && resp.ok) {
      const clone = resp.clone();
      caches.open(cacheName).then(cache => cache.put(request, clone));
    }
    return resp;
  }).catch(() => caches.match(request));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Dados (planilha Google e CSVs do GitHub): sempre tenta rede, cache só offline.
  if (url.hostname.includes('google.com') || url.hostname.includes('githubusercontent.com')) {
    e.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // Só controla arquivos do próprio app (ignora fontes, extensões etc.).
  if (url.origin !== self.location.origin) return;

  // Páginas, JS, CSS e manifest: rede primeiro, pra nunca ficar preso numa versão velha.
  if (req.mode === 'navigate' || /\.(html|js|css|json)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, CACHE_NAME));
    return;
  }

  // Imagens e ícones: cache primeiro.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
      }
      return resp;
    }))
  );
});
