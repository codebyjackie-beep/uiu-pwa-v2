"use client";

import { useEffect, useState } from "react";

/**
 * Home "Kitchen tip" card (Jackie 2026-11-16). The server picks today's three tips (same for everyone);
 * this component shows one of them and moves to the next each time the app is opened.
 *
 * "Opened" = a new browser session: sessionStorage remembers which tip this session is showing, so going
 * back to Home from another tab keeps the same tip. localStorage remembers where the rotation got to.
 */
const ROTATION_KEY = "uiu-kitchen-tip"; // localStorage: "<dateKey>:<index>"
const SESSION_KEY = "uiu-kitchen-tip-session"; // sessionStorage: "<dateKey>:<index>"

function readIndex(store: Storage, key: string, dateKey: string, count: number): number | null {
  const raw = store.getItem(key);
  if (!raw) return null;
  const [date, idx] = raw.split(":");
  const n = Number(idx);
  return date === dateKey && Number.isInteger(n) && n >= 0 && n < count ? n : null;
}

export function KitchenTipCard({ tips, dateKey }: { tips: string[]; dateKey: string }) {
  // null until mounted: the tip to show depends on browser storage, so the text is hidden (space kept) to avoid a flash.
  const [index, setIndex] = useState<number | null>(null);

  useEffect(() => {
    let next = 0;
    try {
      const inSession = readIndex(sessionStorage, SESSION_KEY, dateKey, tips.length);
      if (inSession !== null) {
        next = inSession;
      } else {
        const last = readIndex(localStorage, ROTATION_KEY, dateKey, tips.length);
        next = last === null ? 0 : (last + 1) % tips.length;
        localStorage.setItem(ROTATION_KEY, `${dateKey}:${next}`);
        sessionStorage.setItem(SESSION_KEY, `${dateKey}:${next}`);
      }
    } catch {
      // storage blocked: always show the first tip
    }
    setIndex(next);
  }, [dateKey, tips.length]);

  if (!tips.length) return null;

  return (
    <section className="kitchen-tip-card" aria-label="Kitchen tip">
      <h2 className="kitchen-tip-card__title">Kitchen tip</h2>
      <p className={index === null ? "kitchen-tip-card__text kitchen-tip-card__text--pending" : "kitchen-tip-card__text"}>
        {tips[index ?? 0]}
      </p>
    </section>
  );
}
