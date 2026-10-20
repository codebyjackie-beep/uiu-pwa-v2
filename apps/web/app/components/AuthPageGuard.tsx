"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

/**
 * cc_prompt_shopping_list_price_compare.md Part 0c-B — /sign-in and /sign-up wrap their Clerk form in this. A visitor whose browser is
 * already signed in never needs the form (Clerk renders nothing / a white page and redirects), so send them straight to `redirect_url`
 * (same-site relative paths only) and refresh so the server layout re-reads the session.
 */
function safeRedirect(raw: string | null): string {
  if (!raw) return "/";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  // Clerk's middleware (auth.protect) sends an absolute same-origin URL, e.g. https://useitup.uk/meal-planner — keep its path.
  try {
    const u = new URL(raw);
    if (typeof window !== "undefined" && u.origin === window.location.origin) return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    // not a URL — fall through
  }
  return "/";
}

export function AuthPageGuard({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const target = safeRedirect(params.get("redirect_url"));

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    router.replace(target);
    router.refresh();
  }, [isLoaded, isSignedIn, router, target]);

  if (isLoaded && isSignedIn) return <p className="auth-page__redirecting">Signing you in…</p>;
  return <>{children}</>;
}
