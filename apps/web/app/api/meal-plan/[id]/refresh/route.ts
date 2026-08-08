import { NextRequest, NextResponse } from "next/server";
import { apiPost } from "../../../../lib/api";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiPost(`/api/meal-plan/${id}/refresh`, undefined);
  return NextResponse.json(result);
}
