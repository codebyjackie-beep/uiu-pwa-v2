import { NextRequest, NextResponse } from "next/server";
import { apiDelete } from "../../../../lib/api";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiDelete(`/api/health/meal-logs/${id}`);
  return NextResponse.json(result);
}
