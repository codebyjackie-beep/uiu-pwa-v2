// Kill-switch: removes whatever service worker previously controlled this origin
// (the old Flutter/Workbox build) plus its caches, then unregisters itself.
// Do NOT add real PWA behavior here — that lands in a separate, later commit.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      await self.clients.claim();
      const clientList = await self.clients.matchAll({ type: "window" });
      clientList.forEach((client) => client.navigate(client.url));
    })()
  );
});
