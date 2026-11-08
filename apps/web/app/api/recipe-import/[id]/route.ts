import { NextRequest, NextResponse } from "next/server";
import { apiDelete, apiPut } from "../../../lib/api";

/** Same-origin proxy for editing / deleting the signed-in user's own saved recipe (Jackie 2026-11-07). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await apiPut(`/api/recipe-import/${encodeURIComponent(id)}`, body);
  return NextResponse.json(result, { status: result.ok ? 200 : result.error.code === "not_found" ? 404 : result.error.code === "in_use" ? 409 : 400 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiDelete(`/api/recipe-import/${encodeURIComponent(id)}`);
  return NextResponse.json(result, { status: result.ok ? 200 : result.error.code === "not_found" ? 404 : result.error.code === "in_use" ? 409 : 400 });
}
