import { NextRequest, NextResponse } from "next/server";
import { apiGet, apiPost } from "../../lib/api";

export async function GET() {
  const result = await apiGet("/api/favourite-recipes");
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/favourite-recipes", body);
  return NextResponse.json(result);
}
