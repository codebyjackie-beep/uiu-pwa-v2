"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Mobile-only sticky "Sign up free" bar for /how-it-works. Hidden while the hero is on
 * screen, revealed once it has scrolled out (IntersectionObserver, no scroll listener).
 * Hidden from ≥768px via CSS. Only rendered for signed-out visitors (see page.tsx). */
export function StickySignUpBar({ heroId }: { heroId: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hero = document.getElementById(heroId);
    if (!hero || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(!entry.isIntersecting);
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, [heroId]);

  return (
    <div
      className={visible ? "hiw-sticky-cta hiw-sticky-cta--visible" : "hiw-sticky-cta"}
      aria-hidden={!visible}
    >
      <Link href="/sign-up" className="hiw-btn hiw-btn--primary" tabIndex={visible ? 0 : -1}>
        Sign up free
      </Link>
    </div>
  );
}
