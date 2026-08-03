import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, createSessionCookie, verifyPassword } from "../../../lib/adminSession";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = body?.password ?? "";
  const ok = await verifyPassword(password);
  if (!ok) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "登入失敗" } }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, data: { authenticated: true } });
  res.headers.set("Set-Cookie", await createSessionCookie());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true, data: { authenticated: false } });
  res.headers.set("Set-Cookie", clearSessionCookie());
  return res;
}
