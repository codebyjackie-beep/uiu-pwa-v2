"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import type { PostHog } from "posthog-js";
import {
  clearPostHogStorage,
  loadedPostHog,
  loadPostHog,
  setCapturingAllowed,
  SIGNUP_TRACKED_KEY,
  writeConsentCookie,
  type ConsentState,
} from "../lib/analytics";

/**
 * Consent-gated PostHog analytics (see app/lib/analytics.ts for what is and isn't sent).
 *
 * The provider is rendered by the server layout for every host except shop.useitup.uk. Props come from runtime Workers
 * vars (wrangler.toml [vars]) read in the layout, same as the Clerk props — the CI build has no NEXT_PUBLIC_POSTHOG_* to
 * inline. `initialConsent` is the `uiu_consent` cookie the layout read, so the banner is in the first HTML (no pop-in).
 */
interface AnalyticsValue {
  /** false on shop.useitup.uk / when no PostHog key is configured: no banner, no settings button, nothing loaded. */
  enabled: boolean;
  consent: ConsentState;
  openSettings: () => void;
  /** The posthog instance once consent is granted (loads it on first call); null otherwise. */
  getPostHog: () => Promise<PostHog> | null;
}

const AnalyticsContext = createContext<AnalyticsValue>({
  enabled: false,
  consent: "unset",
  openSettings: () => {},
  getPostHog: () => null,
});

export function AnalyticsProvider({
  posthogKey,
  posthogHost,
  initialConsent,
  children,
}: {
  posthogKey: string;
  posthogHost: string;
  initialConsent: ConsentState;
  children: React.ReactNode;
}) {
  const enabled = !!posthogKey && !!posthogHost;
  const [consent, setConsent] = useState<ConsentState>(initialConsent);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const getPostHog = useCallback(
    () => (enabled && consent === "granted" ? loadPostHog(posthogKey, posthogHost) : null),
    [enabled, consent, posthogKey, posthogHost],
  );

  useEffect(() => {
    if (!enabled) return;
    if (consent === "granted") {
      setCapturingAllowed(true);
      const already = loadedPostHog();
      void loadPostHog(posthogKey, posthogHost)
        .then((ph) => {
          // Accepted again after rejecting in this same page: posthog is already loaded but opted out.
          if (already && ph.has_opted_out_capturing()) ph.opt_in_capturing({ captureEventName: false });
        })
        .catch(() => {});
    } else if (consent === "denied") {
      setCapturingAllowed(false);
      const live = loadedPostHog();
      if (live) {
        void live
          .then((ph) => {
            ph.opt_out_capturing();
            clearPostHogStorage({ keepOptOut: true });
          })
          .catch(() => clearPostHogStorage());
      } else {
        // posthog is not loaded in this page: remove anything left from an earlier "Accept" (incl. its opt-out flag).
        clearPostHogStorage();
      }
    }
  }, [enabled, consent, posthogKey, posthogHost]);

  const choose = useCallback((state: "granted" | "denied") => {
    writeConsentCookie(state);
    setConsent(state);
    setSettingsOpen(false);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const value = useMemo(() => ({ enabled, consent, openSettings, getPostHog }), [enabled, consent, openSettings, getPostHog]);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {enabled && (consent === "unset" || settingsOpen) ? (
        <ConsentBanner current={consent} onChoose={choose} onClose={settingsOpen && consent !== "unset" ? () => setSettingsOpen(false) : undefined} />
      ) : null}
    </AnalyticsContext.Provider>
  );
}

function ConsentBanner({
  current,
  onChoose,
  onClose,
}: {
  current: ConsentState;
  onChoose: (state: "granted" | "denied") => void;
  onClose?: () => void;
}) {
  return (
    <div className="consent-banner" role="region" aria-label="Cookie choices">
      <div className="consent-banner__inner">
        <p className="consent-banner__text">
          Can we use analytics cookies? They tell us which pages people visit so we can improve UseItUp. No health data, no
          recordings.{" "}
          <Link href="/privacy#cookies" className="consent-banner__link">
            Privacy policy
          </Link>
          {current !== "unset" ? (
            <span className="consent-banner__current"> You currently {current === "granted" ? "allow" : "don't allow"} them.</span>
          ) : null}
        </p>
        <div className="consent-banner__actions">
          <button type="button" className="consent-banner__btn" onClick={() => onChoose("denied")}>
            Reject
          </button>
          <button type="button" className="consent-banner__btn" onClick={() => onChoose("granted")}>
            Accept
          </button>
        </div>
        {onClose ? (
          <button type="button" className="consent-banner__close" onClick={onClose}>
            Keep my choice
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** "Cookie settings" — reopens the banner so the visitor can change their choice. Hidden where analytics is off. */
export function CookieSettingsButton({ className }: { className?: string }) {
  const { enabled, openSettings } = useContext(AnalyticsContext);
  if (!enabled) return null;
  return (
    <button type="button" className={className ?? "cookie-settings-button"} onClick={openSettings}>
      Cookie settings
    </button>
  );
}

const FIRST_SESSION_WINDOW_MS = 2 * 60 * 1000;
const RECENT_SIGNUP_MS = 24 * 60 * 60 * 1000;

/**
 * Rendered inside ClerkProvider only (AuthProviders). With consent granted:
 * - signed in → `identify(clerkUserId)` — the Clerk user id and nothing else (no email, name or health fields);
 * - signed out after being identified → `reset()`;
 * - a brand-new account → `sign_up_completed`, once.
 *
 * Sign-up detection uses Clerk's own server timestamps on the user object: the account is new when its last sign-in is
 * the session created by the sign-up itself (`lastSignInAt` within 2 min of `createdAt`; a later sign-in on any device
 * moves `lastSignInAt` on) and the account is under 24 h old. Both timestamps come from Clerk, so the device clock does
 * not matter, and it works for email and Google sign-up alike, whichever page the visitor lands on afterwards.
 * A localStorage flag (`uiu_signup_tracked` = user id, written only after consent) stops a repeat in this browser.
 */
export function AnalyticsIdentity() {
  const { getPostHog, consent } = useContext(AnalyticsContext);
  const { isLoaded, isSignedIn, user } = useUser();
  const userId = user?.id ?? null;
  const createdAt = user?.createdAt?.getTime() ?? null;
  const lastSignInAt = user?.lastSignInAt?.getTime() ?? null;

  useEffect(() => {
    if (!isLoaded || consent !== "granted") return;
    const pending = getPostHog();
    if (!pending) return;
    let cancelled = false;
    void pending
      .then((ph) => {
        if (cancelled) return;
        if (!isSignedIn || !userId) {
          if (ph.get_property("$user_state") === "identified") ph.reset();
          return;
        }
        if (ph.get_distinct_id() !== userId) ph.identify(userId);

        if (createdAt === null) return;
        const firstSession = (lastSignInAt ?? createdAt) - createdAt < FIRST_SESSION_WINDOW_MS;
        const recent = Date.now() - createdAt < RECENT_SIGNUP_MS;
        if (!firstSession || !recent) return;
        let tracked: string | null = null;
        try {
          tracked = localStorage.getItem(SIGNUP_TRACKED_KEY);
        } catch {
          return; // storage blocked: skip rather than risk counting the same sign-up twice
        }
        if (tracked === userId) return;
        ph.capture("sign_up_completed");
        try {
          localStorage.setItem(SIGNUP_TRACKED_KEY, userId);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId, createdAt, lastSignInAt, consent, getPostHog]);

  return null;
}
