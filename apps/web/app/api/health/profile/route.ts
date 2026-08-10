import { NextRequest, NextResponse } from "next/server";
import { apiGet, apiPut } from "../../../lib/api";

export async function GET() {
  const result = await apiGet("/api/health/profile");
  return NextResponse.json(result);
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPut("/api/health/profile", body);
  return NextResponse.json(result);
}
