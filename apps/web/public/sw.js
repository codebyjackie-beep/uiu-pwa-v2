// Real PWA service worker, chained after the original kill-switch (which unregistered
// itself and cleared old Flutter/Workbox caches). Kept the same cache-clearing safety
// net here in case a client never ran the earlier kill-switch version, but this one
// stays registered permanently — Chrome's installability check requires a persistent SW.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
