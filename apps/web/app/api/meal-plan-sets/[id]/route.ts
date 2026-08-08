import { NextRequest, NextResponse } from "next/server";
import { apiDelete, apiGet } from "../../../lib/api";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiGet(`/api/meal-plan-sets/${id}`);
  return NextResponse.json(result);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiDelete(`/api/meal-plan-sets/${id}`);
  return NextResponse.json(result);
}
