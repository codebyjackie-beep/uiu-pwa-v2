import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/** HANDOFF_auth-subscription-front-page.md Milestone 1 — signed-in users need a way back
 * to /how-it-works too (it's not just a signed-out landing page), so this renders on every
 * app-shell page, not only when signed out.
 *
 * cc_prompt_milestone1_followup_fixes.md gap 2 — Clerk's <UserButton /> is the only sign-out
 * entry point in the app. `isSignedIn` is passed down from layout.tsx's auth() check rather
 * than using <SignedIn> — that control component throws in this @clerk/nextjs version ("Core
 * 3" removed it in favour of resource-based auth checks). UserButton inherits
 * afterSignOutUrl="/how-it-works" from the ClerkProvider in layout.tsx. */
export function SiteFooter({ isSignedIn }: { isSignedIn: boolean }) {
  return (
    <div className="site-footer">
      <Link href="/how-it-works" className="site-footer__link">
        How it works
      </Link>
      {isSignedIn && <UserButton />}
    </div>
  );
}
