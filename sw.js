const CACHE = 'wraithflow-shell-v1';
const APP_SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './assets/icon.svg',
  './js/config.js', './js/supabase-client.js', './js/db.js', './js/sync.js', './js/calculations.js', './js/app.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each item independently so a transient third-party CDN failure does
    // not prevent the first successful application shell installation.
    await Promise.all(APP_SHELL.map(async (url) => { try { await cache.add(url); } catch (_) {} }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter((key) => key.startsWith('wraithflow-') && key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Supabase database/auth/storage responses are deliberately not HTTP-cached.
  // IndexedDB is WraithFlow's authenticated offline data layer.
  if (url.hostname.endsWith('.supabase.co')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put('./index.html', copy)); return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  if (request.method !== 'GET') return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok || response.type === 'opaque') { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); }
    return response;
  })));
});
