import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../lib/api";

/** Same-origin proxy so the client-side recipe picker can search without a public API. */
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const result = await apiGet(`/api/recipes${qs ? `?${qs}` : ""}`);
  return NextResponse.json(result);
}
