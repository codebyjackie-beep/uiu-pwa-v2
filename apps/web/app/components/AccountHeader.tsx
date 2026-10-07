"use client";

import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

/** cc_prompt_milestone1_followup_fixes_2.md Task 1 — UserButton moved out of SiteFooter
 * (it was sitting in the fixed bottom strip, not where users look for an account control,
 * and its dropdown opened mid-page over content). This renders top-right on every app-shell
 * page instead. Hidden on pages reached while signed out (how-it-works / sign-in / sign-up) —
 * `isSignedIn` already covers that in practice, this is just belt-and-braces for a signed-in
 * user who navigates back to /how-it-works via the SiteFooter link. */
const HIDDEN_PATHS = ["/how-it-works", "/sign-in", "/sign-up"];

export function AccountHeader({ isSignedIn }: { isSignedIn: boolean }) {
  const pathname = usePathname();
  const hidden = HIDDEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!isSignedIn || hidden) return null;

  return (
    <div className="account-header">
      <div className="account-header__inner">
        <UserButton />
      </div>
    </div>
  );
}
