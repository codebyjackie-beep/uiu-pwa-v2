"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

/**
 * cc_prompt_guest_browse.md Part B — signed-out visitors can browse Recipes only. Anything that
 * writes or lives in another tab calls `requireAuth()` first: signed in → true, carry on;
 * guest → false and the "Sign up free to save this" sheet opens (so no auth-only API is called
 * and no 401 toast appears).
 */
interface GuestGateValue {
  isSignedIn: boolean;
  /** false while Clerk is still loading AND the server render said "guest" — treat as unknown: no banner, no sheet. */
  authResolved: boolean;
  /** true when the action may go ahead; false after opening the sign-up sheet for a guest. */
  requireAuth: () => boolean;
}

const GuestGateContext = createContext<GuestGateValue>({ isSignedIn: true, authResolved: true, requireAuth: () => true });

export function useGuestGate(): GuestGateValue {
  return useContext(GuestGateContext);
}

/** Sign-up / log-in URL that brings the visitor back to the page they were on. */
export function authUrl(kind: "sign-up" | "sign-in", returnTo: string): string {
  return `/${kind}?redirect_url=${encodeURIComponent(returnTo)}`;
}

/**
 * cc_prompt_shopping_list_price_compare.md Part 0c-C — Log in / Sign up navigate through /sign-in, which can take a beat (or bounce
 * straight back), so the tapped link flips to "Loading…" and ignores further taps until the route changes. A 10 s timer re-enables it
 * in case the navigation never completes.
 */
function AuthLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Link
      href={href}
      className={className}
      aria-disabled={loading || undefined}
      style={loading ? { pointerEvents: "none", opacity: 0.7 } : undefined}
      onClick={(e) => {
        if (loading) { e.preventDefault(); return; }
        setLoading(true);
        timer.current = setTimeout(() => setLoading(false), 10000);
      }}
    >
      {loading ? "Loading…" : children}
    </Link>
  );
}

/**
 * cc_prompt_shopping_list_price_compare.md Part 0c-A — the browser's Clerk session is the source of truth. The server `auth()` result
 * (`serverSignedIn`) is only the initial value: on the Clerk dev instance the server-side handshake can fail while the client is still
 * signed in, which used to leave a signed-in visitor looking like a guest (banner + sheet whose "Log in" bounced straight back).
 * Until Clerk has loaded, a server "guest" is "unknown" (`authResolved` false) so nothing guest-only is shown.
 */
export function GuestGateProvider({ serverSignedIn, children }: { serverSignedIn: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { isLoaded, isSignedIn: clerkSignedIn } = useAuth();
  const isSignedIn = isLoaded ? !!clerkSignedIn : serverSignedIn;
  const authResolved = isLoaded || serverSignedIn;

  const requireAuth = useCallback(() => {
    if (isSignedIn) return true;
    if (authResolved) setOpen(true);
    return false;
  }, [isSignedIn, authResolved]);

  const value = useMemo(() => ({ isSignedIn, authResolved, requireAuth }), [isSignedIn, authResolved, requireAuth]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Close the sheet if the visitor navigates away while it is open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <GuestGateContext.Provider value={value}>
      {children}
      {open ? (
        <div className="meal-planner-modal-overlay" onClick={() => setOpen(false)}>
          <div
            className="meal-planner-modal guest-gate-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guest-gate-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="meal-planner-modal__body guest-gate-modal__body">
              <h3 id="guest-gate-title" className="guest-gate-modal__title">
                Sign up free to save this
              </h3>
              <p className="guest-gate-modal__text">
                Create a free account to save recipes, plan meals and build your shopping list.
              </p>
              <AuthLink href={authUrl("sign-up", pathname)} className="wizard-primary-button guest-gate-modal__primary">
                Sign up free
              </AuthLink>
              <AuthLink href={authUrl("sign-in", pathname)} className="guest-gate-modal__secondary">
                Log in
              </AuthLink>
              <button type="button" className="guest-gate-modal__dismiss" onClick={() => setOpen(false)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </GuestGateContext.Provider>
  );
}

/** Slim banner on the recipes pages while signed out. Hidden in full-screen cook mode. */
export function GuestBanner() {
  const { isSignedIn, authResolved } = useGuestGate();
  const pathname = usePathname();
  if (isSignedIn || !authResolved || !pathname.startsWith("/recipes") || pathname.endsWith("/cook")) return null;

  return (
    <div className="guest-banner">
      <p className="guest-banner__text">
        You&apos;re browsing as a guest. Sign up free to save recipes, plan meals and build your shopping list.
      </p>
      <AuthLink href={authUrl("sign-up", pathname)} className="guest-banner__cta">
        Sign up free
      </AuthLink>
    </div>
  );
}

/** The page wrapper: gets the extra top padding for the app header whenever the visitor is signed in (client view, same as AppHeader). */
export function AppShell({ publicShop, children }: { publicShop: boolean; children: React.ReactNode }) {
  const { isSignedIn } = useGuestGate();
  return <div className={!publicShop && isSignedIn ? "app-shell app-shell--with-app-header" : "app-shell"}>{children}</div>;
}
