import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

/** Same-origin proxy for HANDOFF_recipes-page-manual-entry-and-refresh.md §B. */
export async function GET() {
  const result = await apiGet("/api/recipe-browse/refresh-status");
  return NextResponse.json(result);
}
