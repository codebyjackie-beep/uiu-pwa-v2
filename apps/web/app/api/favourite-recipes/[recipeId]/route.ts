import { NextRequest, NextResponse } from "next/server";
import { apiDelete } from "../../../lib/api";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ recipeId: string }> }) {
  const { recipeId } = await params;
  const result = await apiDelete(`/api/favourite-recipes/${recipeId}`);
  return NextResponse.json(result);
}
