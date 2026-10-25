import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../lib/api";

/** Same-origin proxy for "Upload a video" (Jackie 2026-10-25). Video arrives as a base64 data URL (max 14 MB decoded). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await apiPost("/api/recipe-import/from-video", body);
  return NextResponse.json(result);
}
