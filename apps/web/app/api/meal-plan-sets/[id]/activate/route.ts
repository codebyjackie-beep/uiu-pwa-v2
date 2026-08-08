import { NextResponse } from "next/server";
import { apiPost } from "../../../../lib/api";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiPost(`/api/meal-plan-sets/${id}/activate`, undefined);
  return NextResponse.json(result);
}
