import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../lib/api";

/**
 * Same-origin proxy so client components can mutate the meal plan without a public,
 * CORS-exposed API — the browser hits this Next.js route, which forwards over the
 * internal service binding (see apps/web/app/lib/api.ts).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/meal-plan", body);
  return NextResponse.json(result);
}
