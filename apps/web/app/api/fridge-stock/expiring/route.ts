import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

/** Use-it-up list (items expiring soon) — same-origin proxy. */
export async function GET(req: NextRequest) {
  const days = req.nextUrl.searchParams.get("days") ?? "3";
  return NextResponse.json(await apiGet(`/api/fridge-stock/expiring?days=${encodeURIComponent(days)}`));
}
