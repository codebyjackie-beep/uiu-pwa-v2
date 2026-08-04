import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";
import { requireAdminSession } from "../../../lib/adminProxy";

/** Same-origin proxy — requires a valid admin_session cookie, then forwards the server-side
 * ADMIN_TOKEN to the backend's X-Admin-Token header. The token never reaches the browser. */
export async function GET(req: NextRequest) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const result = await apiGet("/api/admin/recipes", { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
