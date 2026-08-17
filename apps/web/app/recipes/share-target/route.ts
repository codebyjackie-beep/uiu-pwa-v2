import { NextRequest, NextResponse } from "next/server";

/**
 * Web Share Target endpoint (manifest.ts `share_target`). TikTok/Instagram
 * usually put the link inside `text` (the whole caption), not `url` — so a
 * URL is pulled from whichever field has one, `url` taking priority, then
 * handed off as a query param to the existing "Save from a link" modal on
 * /recipes rather than importing here directly (user still reviews/confirms).
 */
const URL_PATTERN = /https?:\/\/\S+/;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") ?? "";
  const text = searchParams.get("text") ?? "";
  const url = searchParams.get("url") ?? "";

  const extracted = URL_PATTERN.exec(url)?.[0] ?? URL_PATTERN.exec(text)?.[0] ?? null;

  const dest = req.nextUrl.clone();
  dest.pathname = "/recipes";
  dest.search = "";
  if (extracted) {
    dest.searchParams.set("shareUrl", extracted);
  } else {
    const fallbackText = [title, text].filter(Boolean).join("\n").trim();
    if (fallbackText) dest.searchParams.set("shareText", fallbackText);
  }

  return NextResponse.redirect(dest);
}
