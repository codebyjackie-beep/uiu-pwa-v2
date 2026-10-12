/** Pages a signed-out visitor sees outside the app shell (cc_prompt_welcome_page_v2.md
 * Part D): no bottom nav, no "How it works" footer strip. Same path list AppHeader hides
 * itself on. Signed-in users keep the shell here — they reached /how-it-works from the
 * footer and are already app users. */
const SIGNED_OUT_PUBLIC_PATHS = ["/how-it-works", "/sign-in", "/sign-up"];

export function isSignedOutPublicPath(pathname: string): boolean {
  return SIGNED_OUT_PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
