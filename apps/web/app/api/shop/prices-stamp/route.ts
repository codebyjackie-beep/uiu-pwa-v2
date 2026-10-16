import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

export async function GET() {
  const result = await apiGet("/api/shop/prices-stamp");
  return NextResponse.json(result);
}
