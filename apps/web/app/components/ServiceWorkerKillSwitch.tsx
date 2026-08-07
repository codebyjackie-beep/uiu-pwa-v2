"use client";

import { useEffect } from "react";

// Registers public/sw.js — originally a pure kill-switch for the old Flutter/Workbox
// SW, now upgraded in place to a persistent real SW (still clears stale caches on
// activate as a safety net) so the origin passes Chrome's PWA installability check.
export function ServiceWorkerKillSwitch() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
