"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ClerkProvider } from "@clerk/nextjs";
import { GuestGateProvider, SignedOutGuestGateProvider } from "./GuestGate";
import { AnalyticsIdentity } from "./Analytics";

/**
 * Perf (2026-11-09, Home PageSpeed 70): a fresh visitor to "/" is redirected to /how-it-works, and the root
 * ClerkProvider made that landing page download + run clerk.browser.js (~317 KB) + ui.browser.js (~146 KB) and
 * call Clerk's environment/client endpoints, although the page uses no Clerk UI (its CTA reads the server `auth()`).
 *
 * So on CLERK_FREE_PATHS, when the server render says "signed out", ClerkProvider is not mounted at all and the guest
 * context is the static signed-out one (same values the SSR already used: BottomNav / footer / app header are hidden
 * there for signed-out visitors). As soon as the visitor goes to any other page (sign-up, Home, a tab) ClerkProvider
 * mounts and stays mounted for the rest of the visit. Signed-in visitors always get ClerkProvider, as before.
 *
 * Props come from the server layout (runtime Workers vars) rather than build-time NEXT_PUBLIC_* inlining, because
 * CI builds without those vars — same values the server <ClerkProvider> used to merge in.
 */
export const CLERK_FREE_PATHS = ["/how-it-works"];

export interface ClerkClientProps {
  publishableKey: string;
  signInUrl: string;
  signUpUrl: string;
  afterSignOutUrl: string;
  signInFallbackRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
}

export function AuthProviders({
  serverSignedIn,
  clerkProps,
  children,
}: {
  serverSignedIn: boolean;
  clerkProps: ClerkClientProps;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const clerkFreePage = !serverSignedIn && CLERK_FREE_PATHS.includes(pathname);
  const [clerkMounted, setClerkMounted] = useState(!clerkFreePage);
  useEffect(() => {
    if (!clerkFreePage) setClerkMounted(true);
  }, [clerkFreePage]);

  if (clerkFreePage && !clerkMounted) {
    return <SignedOutGuestGateProvider>{children}</SignedOutGuestGateProvider>;
  }
  return (
    <ClerkProvider {...clerkProps}>
      <GuestGateProvider serverSignedIn={serverSignedIn}>{children}</GuestGateProvider>
      {/* identify / reset / sign_up_completed need Clerk, so they only run where ClerkProvider is mounted; no-op without consent. */}
      <AnalyticsIdentity />
    </ClerkProvider>
  );
}
