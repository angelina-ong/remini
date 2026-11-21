/* remini cloud service worker. It keeps ONLY the app's own files (the "app shell") so the home-screen
 * app opens quickly. Network first, so updates always show up when online.
 * It never touches Google (googleapis, accounts) answers, photos, thumbnails or blob: URLs:
 * anything that isn't one of the files listed below goes straight to the network as usual. */
'use strict';
const CACHE = 'remini:shell-v1'; // Cache Storage is shared with other github.io pages: keep the prefix
const SHELL = [
  './',
  'privacy.html',
  'app.css',
  'config.js',
  'js/app.js',
  'js/logic.js',
  'js/store.js',
  'js/drive.js',
  'js/thumbs.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];
const SCOPE = self.registration.scope; // https://angelina-ong.github.io/remini/
const SHELL_URLS = new Set(SHELL.map(p => new URL(p, SCOPE).href));
const INDEX = new URL('./', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll([...SHELL_URLS]))
    .catch(() => { /* fine: files get cached as they are used */ })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('remini:shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** The cache key for one of our own shell files, or null for everything else. */
function shellKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return null;
  const bare = url.origin + url.pathname;
  if (request.mode === 'navigate') {
    return bare === INDEX || bare === `${INDEX}index.html` ? INDEX : null;
  }
  if (url.search) return null;
  return SHELL_URLS.has(bare) ? bare : null;
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      cache.put(key, response.clone()).catch(() => {});
      return response;
    }
    if (response.status >= 500) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    return response;
  } catch (err) { // offline
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const key = shellKey(event.request);
  if (key) event.respondWith(networkFirst(event.request, key));
});
