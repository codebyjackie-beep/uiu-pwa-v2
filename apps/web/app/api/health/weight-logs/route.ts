import { NextRequest, NextResponse } from "next/server";
import { apiGet, apiPost } from "../../../lib/api";

export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get("limit");
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : "";
  const result = await apiGet(`/api/health/weight-logs${qs}`);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/health/weight-logs", body);
  return NextResponse.json(result);
}
