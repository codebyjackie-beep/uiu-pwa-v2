import { NextRequest, NextResponse } from "next/server";
import { apiGet, apiPostForm } from "../../../lib/api";

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get("range") ?? "today";
  const result = await apiGet(`/api/health/meal-logs?range=${encodeURIComponent(range)}`);
  return NextResponse.json(result);
}

/** Photo upload — multipart passthrough, same pattern as fridge-stock/ocr. */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: { code: "bad_request", message: "multipart/form-data body required" } }, { status: 400 });
  }
  const result = await apiPostForm("/api/health/meal-logs", form);
  return NextResponse.json(result);
}
