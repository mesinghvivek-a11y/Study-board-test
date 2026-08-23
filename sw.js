// Study Board — service worker
// Handles: app-shell caching (so it opens instantly / offline-ish),
// and push notifications (Firebase Cloud Messaging arrives here as a
// plain Web Push event, so we do NOT need the separate firebase-messaging-sw
// script — this one file handles both).

const CACHE_NAME = 'study-board-v3'; // bumped so old installs drop their stale cache
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the app page itself (so signed-in users always see
// live Firestore-backed content when online), falling back to the cached
// shell when offline. Cache-first for everything else (icons, fonts, etc).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isAppPage = req.mode === 'navigate' || req.url.includes('index.html');

  if (isAppPage) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});

// ---------- Push notifications ----------
// Firebase Cloud Messaging can deliver a payload in two shapes depending on
// how it was sent: either flat ({title, body, ...}) or FCM's own wrapped
// "notification" shape ({notification: {title, body}, data: {...}}). This
// handler accepts either, so a message doesn't silently show up blank.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Study Board', body: event.data ? event.data.text() : '' }; }

  const notif = data.notification || {};
  const custom = data.data || {};

  const title = notif.title || data.title || 'Study Board';
  const body = notif.body || data.body || '';
  const url = custom.url || data.url || './index.html';

  const options = {
    body,
    icon: notif.icon || './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url },
    vibrate: [100, 50, 100]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('index.html') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
