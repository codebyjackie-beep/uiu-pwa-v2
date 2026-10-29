import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../../lib/api";
import { requireAdminSession } from "../../../../../lib/adminProxy";

/** Proxies POST /api/admin/recipe-drafts/triage/apply (apps/api services/recipeDraftTriage.ts). Token stays server-side. */
export async function POST(req: NextRequest) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const result = await apiPost("/api/admin/recipe-drafts/triage/apply", body, { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
