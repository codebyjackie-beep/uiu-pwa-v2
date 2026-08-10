import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../lib/api";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/health/meal-logs/manual", body);
  return NextResponse.json(result);
}
