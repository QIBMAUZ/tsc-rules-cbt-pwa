const CACHE_NAME = 'tsc-rules-cbt-v25';
const APP_SHELL = ['./','./index.html','./config.js','./manifest.json','./questions.json','./assets/ogun-teaching-service-manual-background.png','./icons/icon-192.png','./icons/icon-512.png'];
const CACHE_PATHS = new Set(['/', '/index.html', '/config.js', '/manifest.json', '/questions.json', '/assets/ogun-teaching-service-manual-background.png', '/icons/icon-192.png', '/icons/icon-512.png']);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/_vercel/insights/') || url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => {
    if (cached) return cached;
    return fetch(event.request).then(response => {
      if (CACHE_PATHS.has(url.pathname)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match('./index.html'));
  }));
});
