import { NextRequest, NextResponse } from "next/server";
import { apiPatch } from "../../../../lib/api";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = req.headers.get("X-Admin-Token") ?? "";
  const body = await req.json().catch(() => null);
  const result = await apiPatch(`/api/admin/recipe-drafts/${id}`, body, { "X-Admin-Token": token });
  return NextResponse.json(result);
}
