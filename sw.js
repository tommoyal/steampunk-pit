/* 1577 Pit — offline support.
   Network-first: when online, always load the newest files from the server;
   the cache is only used when the network is unavailable (offline at events). */
const CACHE = 'pit-v20';
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const EXTERNAL = [FB + 'firebase-app-compat.js', FB + 'firebase-firestore-compat.js', FB + 'firebase-auth-compat.js',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600;700&display=swap'];
const SHELL = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  // cache:'reload' skips the browser's HTTP cache so we never store an old copy
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    // also save the sign-in/sync library and fonts, so the app opens with no internet at all
    await Promise.all(EXTERNAL.map(u => fetch(u).then(r => { if (r.ok) return c.put(u, r); }).catch(() => { })));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(async ks => {
    const cur = await caches.open(CACHE);
    for (const k of ks.filter(k => k !== CACHE)) {
      // keep saved fonts and libraries from the old version so offline keeps working after an update
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        if (new URL(req.url).origin !== location.origin && !(await cur.match(req))) { const r = await old.match(req); if (r) await cur.put(req, r); }
      }
      await caches.delete(k);
    }
  }).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin === location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }
  if (u.hostname === 'www.gstatic.com' || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
