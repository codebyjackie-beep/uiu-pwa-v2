import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for HANDOFF_recipe-photo-import.md §2. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/recipe-import/from-photo", body);
  return NextResponse.json(result);
}
