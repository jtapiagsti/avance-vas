/* Service worker: cachea la "cáscara" de la app y trae el CSV siempre desde la red primero.
 * Si cambias archivos de la app, sube el número de versión para forzar la actualización. */
const VERSION = 'v6';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = 'data';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCsvRequest(url) {
  return url.hostname.endsWith('docs.google.com') ||
         url.hostname.endsWith('googleusercontent.com') ||
         /\.csv$/i.test(url.pathname) ||
         /(output|format)=csv/i.test(url.search);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 1) CSV: red primero; si falla, la última copia guardada.
  if (isCsvRequest(url)) {
    event.respondWith((async () => {
      const key = url.origin + url.pathname + url.search.replace(/[?&]t=\d+/, ''); // sin el ?t=
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh.ok) {
          const cache = await caches.open(DATA_CACHE);
          cache.put(key, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match(key, { cacheName: DATA_CACHE });
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // 2) Librería del CDN (versión fija, nunca cambia): caché primero.
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }

  // 3) Archivos de la app: red primero (siempre la versión más nueva);
  //    si no hay conexión o tarda más de 4 s, la copia guardada.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const fromCache = () => cache.match(req, { ignoreSearch: true })
      .then((c) => c || (req.mode === 'navigate' ? cache.match('./index.html') : undefined));
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
      return (await fromCache()) || (await network);
    } catch (_) {
      return (await fromCache()) || Response.error();
    }
  })());
});
