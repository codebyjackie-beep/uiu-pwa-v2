import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Milestone 3 Phase B: starts a Stripe Checkout session. Body: { interval: "month" | "year" }. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return NextResponse.json(await apiPost("/api/billing/checkout", body));
}
