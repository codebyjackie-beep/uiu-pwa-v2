import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../../lib/api";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = req.headers.get("X-Admin-Token") ?? "";
  const result = await apiPost(`/api/admin/recipe-drafts/${id}/approve`, undefined, { "X-Admin-Token": token });
  return NextResponse.json(result);
}
