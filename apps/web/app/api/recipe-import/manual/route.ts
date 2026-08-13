import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for HANDOFF_recipes-page-manual-entry-and-refresh.md §A. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/recipe-import/manual", body);
  return NextResponse.json(result);
}
