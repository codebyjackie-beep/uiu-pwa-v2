import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

export async function POST(req: NextRequest) {
  return NextResponse.json(await apiPost("/api/push/unsubscribe", await req.json().catch(() => null)));
}
