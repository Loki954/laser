// Service worker: offline app shell + automatic updates. VERSION is stamped by the deploy workflow.
const VERSION = 'dev';
const CACHE = 'sfs-' + VERSION;
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/editor.js', 'js/scene.js', 'js/shapes.js', 'js/geometry.js', 'js/raster.js', 'js/gcode.js',
  'js/machine.js', 'js/transport.js', 'js/text.js', 'js/storage.js', 'js/ui.js', 'js/presets.js', 'js/svg.js', 'js/version.js',
  'vendor/opentype.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'fonts/roboto-bold.ttf', 'fonts/roboto.ttf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => fetch(u, { cache: 'reload' }).then(r => { if (r.ok) return c.put(u, r); })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('sfs-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('version.json')) return; // always network
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req, { cache: 'reload' });
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (err) {
      if (req.mode === 'navigate') { const idx = await c.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
