import { NextRequest, NextResponse } from "next/server";
import { apiDelete, apiPatch } from "../../../lib/api";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const result = await apiPatch(`/api/shopping-list/${id}`, body);
  return NextResponse.json(result);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiDelete(`/api/shopping-list/${id}`);
  return NextResponse.json(result);
}
