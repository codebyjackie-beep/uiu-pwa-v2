import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

/** Same-origin proxy — forwards the admin token the client sent to the backend's X-Admin-Token header, per the existing /api/meal-plan proxy pattern. */
export async function GET(req: NextRequest) {
  const token = req.headers.get("X-Admin-Token") ?? "";
  const status = req.nextUrl.searchParams.get("status");
  const path = status ? `/api/admin/recipe-drafts?status=${encodeURIComponent(status)}` : "/api/admin/recipe-drafts";
  const result = await apiGet(path, { "X-Admin-Token": token });
  return NextResponse.json(result);
}
