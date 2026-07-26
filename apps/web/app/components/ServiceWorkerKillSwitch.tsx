"use client";

import { useEffect } from "react";

// Registers the kill-switch SW (public/sw.js) so it replaces whatever service
// worker previously controlled this origin. Remove this once the old SW is
// confirmed dead everywhere and before a real PWA SW is introduced.
export function ServiceWorkerKillSwitch() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
