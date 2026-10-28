import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

/** Milestone 3: the signed-in user's plan + this month's usage (apps/api GET /api/me/plan). */
export async function GET() {
  return NextResponse.json(await apiGet("/api/me/plan"));
}
