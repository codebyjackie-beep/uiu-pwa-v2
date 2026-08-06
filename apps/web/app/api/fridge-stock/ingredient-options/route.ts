import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

export async function GET() {
  const result = await apiGet("/api/fridge-stock/ingredient-options");
  return NextResponse.json(result);
}
