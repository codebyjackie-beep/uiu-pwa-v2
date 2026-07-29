import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for the wizard's preview step — forwards to the read-only generator endpoint. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/meal-plan/generate", body);
  return NextResponse.json(result);
}
