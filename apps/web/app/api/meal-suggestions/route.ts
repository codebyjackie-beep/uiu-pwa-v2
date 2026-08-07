import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../lib/api";

/** Same-origin proxy so the Meal Planner "what should I eat" widget can call the API
 * without CORS (HANDOFF_tonight-suggestion.md — this layer was missed on the first
 * Fridge tab pass, causing a production 404; do not skip it here). */
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const result = await apiGet(`/api/meal-suggestions${qs ? `?${qs}` : ""}`);
  return NextResponse.json(result);
}
