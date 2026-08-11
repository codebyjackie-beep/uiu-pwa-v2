import { NextRequest, NextResponse } from "next/server";
import { apiGet } from "../../../../../lib/api";
import { requireAdminSession } from "../../../../../lib/adminProxy";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const result = await apiGet(`/api/admin/recipe-drafts/${id}/cost-lines`, { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
