import { NextResponse } from "next/server";
import { apiGet } from "../../../lib/api";

export async function GET() {
  return NextResponse.json(await apiGet("/api/push/public-key"));
}
