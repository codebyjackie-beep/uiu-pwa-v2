import { NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Milestone 3 Phase B: opens the Stripe Billing Portal (change card, cancel). */
export async function POST() {
  return NextResponse.json(await apiPost("/api/billing/portal", {}));
}
