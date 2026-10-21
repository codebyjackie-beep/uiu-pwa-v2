import { NextRequest, NextResponse } from "next/server";
import { apiDelete, apiPatch } from "../../../lib/api";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await apiPatch(`/api/fridge-stock/${id}`, body);
  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Impact: ?outcome=used|wasted is passed through (anything else is dropped).
  const outcome = req.nextUrl.searchParams.get("outcome");
  const q = outcome === "used" || outcome === "wasted" ? `?outcome=${outcome}` : "";
  const result = await apiDelete(`/api/fridge-stock/${id}${q}`);
  return NextResponse.json(result);
}
