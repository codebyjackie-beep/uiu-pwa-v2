import { NextRequest, NextResponse } from "next/server";
import { apiPatch } from "../../../../lib/api";
import { requireAdminSession } from "../../../../lib/adminProxy";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await apiPatch(`/api/admin/recipe-drafts/${id}`, body, { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
