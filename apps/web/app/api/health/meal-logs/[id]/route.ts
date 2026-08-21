import { NextRequest, NextResponse } from "next/server";
import { apiDelete, apiPatch } from "../../../../lib/api";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiDelete(`/api/health/meal-logs/${id}`);
  return NextResponse.json(result);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await apiPatch(`/api/health/meal-logs/${id}`, body);
  return NextResponse.json(result);
}
