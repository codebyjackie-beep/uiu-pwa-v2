"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

/** cc_prompt_milestone1_followup_fixes_2.md Task 1 (renamed from AccountHeader in
 * cc_prompt_account_header_to_app_header.md) — a lone avatar floating in an empty 56px
 * strip didn't read as a header, so this is now a real app header: UseItUp wordmark on
 * the left, UserButton on the right. Renders top-right/left on every app-shell page.
 * Hidden on pages reached while signed out (how-it-works / sign-in / sign-up) and on
 * /recipes/[id]/cook (future cook-mode, full-bleed). */
const HIDDEN_PATHS = ["/how-it-works", "/sign-in", "/sign-up"];

export function AppHeader({ isSignedIn }: { isSignedIn: boolean }) {
  const pathname = usePathname();
  const hidden =
    HIDDEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ||
    pathname.endsWith("/cook");

  if (!isSignedIn || hidden) return null;

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href="/" className="app-header__wordmark">
          UseItUp
        </Link>
        <UserButton />
      </div>
    </header>
  );
}
