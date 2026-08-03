import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../../lib/api";
import { requireAdminSession } from "../../../../../lib/adminProxy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminSession(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const result = await apiPost(`/api/admin/recipe-drafts/${id}/approve`, undefined, { "X-Admin-Token": auth.token });
  return NextResponse.json(result);
}
