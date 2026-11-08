import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../../lib/api";
import { requireAdminSession } from "../../../../../lib/adminProxy";

/** Proxies POST /api/admin/recipe-drafts/:id/reopen (apps/api services/recipeDraftOverride.ts).
 * Dry-run unless ?write=true; token stays server-side. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const write = req.nextUrl.searchParams.get("write") === "true";
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await apiPost(`/api/admin/recipe-drafts/${id}/reopen${write ? "?write=true" : ""}`, { note: body.note, by: "admin-ui" }, { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
