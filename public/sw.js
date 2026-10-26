// Service worker: lets the app open without signal (the app shell is cached) and shows
// push notifications. API calls always go to the network; leads typed offline are kept
// on the phone by the app itself and sent when the connection is back.
const CACHE = 'eo-shell-v3';
const SHELL = ['/', '/app.js', '/energy.js', '/controls.js', '/styles.css', '/leadscore.js', '/waformat.js', '/manifest.webmanifest', '/icon.svg', '/brand/mark.svg', '/brand/chevron-down.svg', '/brand/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, so updates show up straight away; the cache is only the fallback.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(url.pathname === '/index.html' ? '/' : req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'E&O Referrals', {
    body: data.body || '',
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) return win.focus().then(() => win.navigate(target)).catch(() => self.clients.openWindow(target));
    return self.clients.openWindow(target);
  }));
});
