import { NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for HANDOFF_recipes-page-manual-entry-and-refresh.md §B. */
export async function POST() {
  const result = await apiPost("/api/recipe-browse/refresh", undefined);
  return NextResponse.json(result);
}
