import { NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";
import { GUEST_COOKIE } from "../../../lib/guestCookie";
import { cookies } from "next/headers";

/** Guest mode: after sign-in, forwards the Clerk session (apiPost/withAuth) + the guest cookie to /api/guest/claim,
 * then drops the guest cookie whenever the visitor is signed in (claimed or not, the guest id is finished). */
export async function POST() {
  const jar = await cookies();
  const guest = jar.get(GUEST_COOKIE)?.value;
  if (!guest) return NextResponse.json({ ok: true, data: { claimed: false, reason: "no_guest_cookie", moved: {} } });
  const result = await apiPost("/api/guest/claim", {}, { "X-Guest-Token": guest });
  const res = NextResponse.json(result);
  if (result.ok) res.cookies.delete(GUEST_COOKIE);
  return res;
}
