import { NextRequest, NextResponse } from "next/server";
import { apiGet, apiPost } from "../../lib/api";

/** Same-origin proxy so the Fridge page can read/write fridge_stock without a public API. */
export async function GET() {
  const result = await apiGet("/api/fridge-stock");
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/fridge-stock", body);
  return NextResponse.json(result);
}
