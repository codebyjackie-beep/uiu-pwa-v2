import { NextRequest, NextResponse } from "next/server";
import { getAdminToken, verifySessionFromRequest } from "./adminSession";

/** Guards the recipe-drafts proxy routes: requires a valid admin_session cookie, then
 * hands back the server-side ADMIN_TOKEN so the caller can forward it to apps/api.
 * The token never reaches the browser. */
export async function requireAdminSession(req: NextRequest): Promise<{ token: string } | NextResponse> {
  const valid = await verifySessionFromRequest(req);
  if (!valid) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Session 已過期，請重新登入。" } }, { status: 401 });
  }
  const token = await getAdminToken();
  return { token };
}
