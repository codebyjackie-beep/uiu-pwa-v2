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

// Use-it-up reminders (apps/api services/webPush.ts): payload-less push, fixed message, tap opens /fridge.
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Use it up", {
      body: "Some food in your fridge expires soon — tap to see what to use first.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "uiu-expiring",
      data: { url: "/fridge" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/fridge";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
