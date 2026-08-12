import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for HANDOFF_recipe-social-import.md §3. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/recipe-import/from-text", body);
  return NextResponse.json(result);
}
