import { NextRequest, NextResponse } from "next/server";
import { apiPostForm } from "../../../lib/api";

/** Analysis-only — returns scanned items for the client to review, does not write to fridge_stock. */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: { code: "bad_request", message: "multipart/form-data body required" } }, { status: 400 });
  }
  const result = await apiPostForm("/api/fridge-stock/scan-fridge", form);
  return NextResponse.json(result);
}
