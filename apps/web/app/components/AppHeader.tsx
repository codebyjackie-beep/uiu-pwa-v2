"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { authUrl, isAppHeaderHidden, useGuestGate } from "./GuestGate";

/** cc_prompt_milestone1_followup_fixes_2.md Task 1 (renamed from AccountHeader in
 * cc_prompt_account_header_to_app_header.md) — a lone avatar floating in an empty 56px
 * strip didn't read as a header, so this is now a real app header: UseItUp wordmark on
 * the left, UserButton on the right. Renders top-right/left on every app-shell page.
 * Hidden on pages reached while signed out (how-it-works / sign-in / sign-up) and on
 * /recipes/[id]/cook (future cook-mode, full-bleed). */

export function AppHeader() {
  const { isSignedIn, authResolved } = useGuestGate();
  const { user } = useUser();
  const pathname = usePathname();
  if (isAppHeaderHidden(pathname)) return null;

  // Guest mode: guests get the same header with a Sign up button instead of the avatar.
  if (!isSignedIn) {
    return (
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="app-header__wordmark" aria-label="USE IT UP! home">
            <span className="app-header__sticker">USE IT UP!</span>
          </Link>
          {authResolved ? (
            <Link href={authUrl("sign-up", pathname)} className="app-header__signup">
              Sign up free
            </Link>
          ) : null}
        </div>
      </header>
    );
  }

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href="/" className="app-header__wordmark" aria-label="USE IT UP! home">
          <span className="app-header__sticker">USE IT UP!</span>
        </Link>
        {/* cc_prompt_meal_grid_profile.md Part P — the avatar opens /profile (Account / Sign out live there now). */}
        <Link href="/profile" className="app-header__avatar" aria-label="Profile">
          {user?.hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.imageUrl} alt="" width={32} height={32} />
          ) : (
            <span aria-hidden="true">{(user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "?").toUpperCase()}</span>
          )}
        </Link>
      </div>
    </header>
  );
}
