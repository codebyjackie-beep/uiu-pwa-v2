import { NextResponse } from "next/server";
import { apiGet } from "../../lib/api";

export async function GET() {
  const result = await apiGet("/api/affiliate-products");
  return NextResponse.json(result);
}
