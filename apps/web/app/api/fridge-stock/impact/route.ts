import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

/** Impact card (used vs thrown away) — same-origin proxy. */
export async function GET() {
  return NextResponse.json(await apiGet("/api/fridge-stock/impact"));
}
