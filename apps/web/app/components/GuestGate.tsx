"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

/**
 * Guest mode (claude/plan_guest_mode.md, Jackie 2026-10-20): signed-out visitors can use every tab; what they add is
 * kept server-side under a temporary guest id (cookie `uiu_guest`, 7 days) and moved into the account when they sign
 * up. Only Premium functions need an account: `requireAccount()` opens the sign-up sheet for a guest, and any
 * same-origin /api response with error code `guest_forbidden` opens it too (so every Premium button is covered).
 * `requireAuth()` is kept for existing call sites and now lets guests through.
 */
interface GuestGateValue {
  isSignedIn: boolean;
  /** false while Clerk is still loading AND the server render said "guest" — treat as unknown: no banner, no sheet. */
  authResolved: boolean;
  /** true when the action may go ahead (signed in or guest). */
  requireAuth: () => boolean;
  /** Premium / account-only actions: true when signed in; a guest gets the sign-up sheet and false. */
  requireAccount: () => boolean;
}

const GuestGateContext = createContext<GuestGateValue>({ isSignedIn: true, authResolved: true, requireAuth: () => true, requireAccount: () => true });

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

  const requireAuth = useCallback(() => true, []);
  const requireAccount = useCallback(() => {
    if (isSignedIn) return true;
    if (authResolved) setOpen(true);
    return false;
  }, [isSignedIn, authResolved]);

  const value = useMemo(() => ({ isSignedIn, authResolved, requireAuth, requireAccount }), [isSignedIn, authResolved, requireAuth, requireAccount]);

  // Any Premium call a guest makes comes back with error code guest_forbidden (apps/api guestForbidden) → sign-up sheet.
  useEffect(() => {
    const original = window.fetch;
    const patched: typeof window.fetch = async (input, init) => {
      const res = await original(input, init);
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const sameOriginApi = url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
        if (sameOriginApi && (res.headers.get("content-type") ?? "").includes("application/json")) {
          const body = (await res.clone().json().catch(() => null)) as { ok?: boolean; error?: { code?: string } } | null;
          if (body && body.ok === false && body.error?.code === "guest_forbidden") setOpen(true);
        }
      } catch {
        // never let the check break the request
      }
      return res;
    };
    window.fetch = patched;
    return () => {
      if (window.fetch === patched) window.fetch = original;
    };
  }, []);

  // After sign-in / sign-up, once per browser session: sync the users doc (B), then move this browser's guest data into
  // the account (new accounts only; the API decides).
  useEffect(() => {
    if (!isLoaded || !clerkSignedIn) return;
    let done = false;
    try {
      done = sessionStorage.getItem("uiu_guest_claim_done") === "1";
    } catch {
      // storage blocked — just try once more
    }
    if (done) return;
    void (async () => {
      // B: make sure the users doc exists whichever page the visitor lands on after sign-in (Home also syncs; idempotent).
      await fetch("/api/users/sync", { method: "POST" }).catch(() => null);
      const res = await fetch("/api/guest/claim", { method: "POST" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { ok?: boolean; data?: { claimed?: boolean } } | null;
      try {
        sessionStorage.setItem("uiu_guest_claim_done", "1");
      } catch {
        // ignore
      }
      // Client pages (e.g. Fridge) load their lists on mount — usually before the claim finished — and router.refresh()
      // does not re-run those effects, so the moved data looked missing (Jackie test 2026-10-22). Reload once instead.
      if (body?.ok && body.data?.claimed) window.location.reload();
    })();
  }, [isLoaded, clerkSignedIn]);

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
                Sign up free to use this
              </h3>
              <p className="guest-gate-modal__text">
                This feature needs a free account. Signing up also keeps everything you&apos;ve added as a guest.
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

/** Guest mode: slim banner on every app page while signed out — states that guest data is not saved. Hidden in full-screen cook mode. */
const GUEST_BANNER_PREFIXES = ["/recipes", "/meal-planner", "/fridge", "/shop", "/health"];
export function GuestBanner() {
  const { isSignedIn, authResolved } = useGuestGate();
  const pathname = usePathname();
  const onAppPage = pathname === "/" || GUEST_BANNER_PREFIXES.some((p) => pathname.startsWith(p));
  if (isSignedIn || !authResolved || !onAppPage || pathname.endsWith("/cook")) return null;

  return (
    <div className="guest-banner">
      <p className="guest-banner__text">
        You&apos;re using UseItUp as a guest — nothing you add is saved. Sign up free to keep it.
      </p>
    </div>
  );
}

/** The page wrapper: gets the extra top padding for the app header whenever the visitor is signed in (client view, same as AppHeader). */
export function AppShell({ publicShop, children }: { publicShop: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  // Guest mode: the app header shows for guests too (with a Sign up button), so the padding follows the header's own rule.
  const withHeader = !publicShop && !isAppHeaderHidden(pathname);
  return <div className={withHeader ? "app-shell app-shell--with-app-header" : "app-shell"}>{children}</div>;
}

/** Pages without the app header (signed-out intro / auth pages / full-screen cook mode). Shared by AppHeader and AppShell. */
export function isAppHeaderHidden(pathname: string): boolean {
  return ["/how-it-works", "/sign-in", "/sign-up"].some((p) => pathname === p || pathname.startsWith(`${p}/`)) || pathname.endsWith("/cook");
}
