"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isSignedOutPublicPath } from "../lib/signedOutPublicPaths";
import { useGuestGate } from "./GuestGate";

/** HANDOFF_auth-subscription-front-page.md Milestone 1 — signed-in users need a way back
 * to /how-it-works too (it's not just a signed-out landing page), so this renders on every
 * app-shell page, not only when signed out.
 *
 * cc_prompt_milestone1_followup_fixes_2.md Task 1 — UserButton moved to AppHeader
 * (top of every page); this strip is back to just the "How it works" link.
 *
 * cc_prompt_recipe-list-redesign-and-cook-mode.md Part C — hidden on cook mode
 * (/recipes/[id]/cook), which is full-screen. */
/** Plain-language device label for the feedback email (no user id, no full user-agent string). */
function deviceLabel(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  return `${os} · ${browser}`;
}

const FEEDBACK_EMAIL = "useitup.uk@gmail.com";

/** Launch beta (Jackie 2026-10-23): one tap opens an email to the brand inbox with the page and device pre-filled. */
function feedbackHref(pathname: string, device: string, installed: boolean): string {
  const subject = "UseItUp feedback";
  const body = [
    "What happened / what would you change?",
    "",
    "",
    "---",
    `Page: ${pathname}`,
    `Device: ${device}${installed ? " · installed app" : " · browser"}`,
  ].join("\n");
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function SiteFooter() {
  const { isSignedIn } = useGuestGate();
  const pathname = usePathname();
  const [device, setDevice] = useState("unknown");
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setDevice(deviceLabel(navigator.userAgent));
    setInstalled(window.matchMedia?.("(display-mode: standalone)").matches ?? false);
  }, []);
  if (!isSignedIn && isSignedOutPublicPath(pathname)) return null;
  if (pathname.endsWith("/cook")) return null;

  return (
    <div className="site-footer">
      <Link href="/how-it-works" className="site-footer__link">
        How it works
      </Link>
      <Link href="/privacy" className="site-footer__link">
        Privacy
      </Link>
      <a href={feedbackHref(pathname, device, installed)} className="site-footer__link">
        Feedback
      </a>
    </div>
  );
}
