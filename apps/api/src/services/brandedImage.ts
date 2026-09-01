/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — 2026-08-25 addendum (Jackie, after
 * reviewing live posts: "人哋睇個post唔會知你個張圖想講啲乜") — composites the post's
 * hook line onto its background photo, so the point of the post is visible in-feed
 * without a reader tapping "more".
 *
 * 2026-08-25 rewrite (Jackie, after this hit 3 separate production-only bugs in a row —
 * Google Fonts woff/ttf mismatch, then a harfbuzz module-load crash, then a Cloudflare
 * isolate-reuse "already called" init guard — all traced back to the same layer):
 * the previous version used `satori` (JSX-shaped tree -> SVG) purely for 3 fixed pieces of
 * layout (gradient rect, hook text, handle chip) that don't need a flexbox/text-shaping
 * engine at all. This version hand-writes the SVG directly and uses `@cf-wasm/resvg`
 * (SVG -> PNG, runs natively in Workers) as the ONLY rendering dependency — satori and its
 * harfbuzz dependency chain are removed entirely.
 *
 * The hook font is bundled at build time (`assets/hook-font.ttf`, Poppins ExtraBold,
 * OFL-licensed — see assets/hook-font.OFL.txt) as a `wrangler.toml` `[[rules]] type = "Data"`
 * import, i.e. a plain ArrayBuffer baked into the deployed bundle. This replaces the old
 * per-request Google Fonts fetch: one less runtime dependency, one less way for this to break.
 *
 * resvg-wasm cannot fetch the background photo itself and has no network access inside the
 * wasm sandbox, so the background image is fetched here and inlined as a base64 data: URI
 * before being embedded in the SVG.
 */
import { Resvg, initResvg } from "@cf-wasm/resvg/workerd";
import hookFontData from "../../assets/hook-font.ttf";
import { webpToPng } from "./webpTranscode";

export type BrandAccount = "uiu" | "affiliate";

interface Palette {
  /** Bottom gradient / handle-chip base — both accounts are dark per Jackie's brief (2026-08-22 CLAUDE.md §3 black/white/green). */
  overlay: string;
  accent: string;
  text: string;
  handle: string;
}

/**
 * 2026-09-01: both accounts now publish to the single @useitup.app account (2026-08-31 brand
 * merge, accountFor() in jobs/igContentAgent.ts) — this used to say "@kura.nook" with the KN
 * logo watermark and never got updated when the account was retired. Fixed here (found while
 * building the collage renderer, which must not inherit the stale branding).
 */
const PALETTES: Record<BrandAccount, Palette> = {
  uiu: { overlay: "#0a0a0a", accent: "#16a34a", text: "#ffffff", handle: "@useitup.app" },
  // Distinct brighter green so affiliate posts are still visually distinguishable from organic
  // ones in-feed, even though both post to the same account now.
  affiliate: { overlay: "#0a0a0a", accent: "#22c55e", text: "#ffffff", handle: "@useitup.app" },
};

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function toDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Background image fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(await res.arrayBuffer());
  let outContentType = contentType;
  // resvg can't decode WebP (see webpTranscode.ts header) — transcode to PNG before embedding.
  if (contentType === "image/webp") {
    bytes = await webpToPng(bytes);
    outContentType = "image/png";
  }
  return `data:${outContentType};base64,${bytesToBase64(bytes)}`;
}

export function escapeXml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * `@cf-wasm/resvg/workerd`'s own entrypoint module (dist/workerd.js) already calls
 * `initResvg(resvgWasmModule)` itself as a module-load-time side effect the moment it's
 * imported — confirmed by reading that file directly. Calling `initResvg()` again ourselves
 * is what caused the earlier "(@cf-wasm/resvg): Function already called" production error
 * (it fired on literally the first request in a fresh isolate, not an isolate-reuse race as
 * originally suspected). We only need to wait on the init the import already triggered.
 */
export function ensureWasm(): Promise<void> {
  return initResvg.ensure();
}

/** Hook font size shrinks as the hook gets longer so a ~125-char hook still fits the overlay band. */
function hookFontSize(hookLength: number): number {
  if (hookLength <= 55) return 66;
  if (hookLength <= 85) return 54;
  return 44;
}

/**
 * SVG has no auto-wrap for `<text>` — greedy word-wrap using an estimated average glyph
 * width (Poppins ExtraBold runs close to 0.6x font-size per character for this kind of
 * short punchy hook copy). Good enough for a 1-3 line headline; not a general text-layout engine.
 */
function wrapHook(hook: string, fontSize: number, maxWidth: number): string[] {
  const avgCharWidth = fontSize * 0.6;
  const maxCharsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  const words = hook.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface RenderBrandedImageParams {
  backgroundImageUrl: string;
  hook: string;
  account: BrandAccount;
}

/** Renders a 1080x1080 IG feed image: background photo + bottom gradient + hook headline + handle watermark. */
export async function renderBrandedImage(params: RenderBrandedImageParams): Promise<Uint8Array> {
  const palette = PALETTES[params.account];
  const [bgDataUri] = await Promise.all([toDataUri(params.backgroundImageUrl), ensureWasm()]);

  const fontSize = hookFontSize(params.hook.length);
  const lineHeight = fontSize * 1.18;
  const textLeft = 56;
  const textRight = 1080 - 56;
  const maxTextWidth = textRight - textLeft;
  const lines = wrapHook(params.hook, fontSize, maxTextWidth);
  const bottomY = 1080 - 88;
  const firstLineY = bottomY - lineHeight * (lines.length - 1);
  const hookTspans = lines
    .map((line, i) => `<tspan x="${textLeft}" y="${firstLineY + lineHeight * i}">${escapeXml(line)}</tspan>`)
    .join("");

  const handleText = escapeXml(palette.handle);
  // 2026-09-01: KN logo watermark removed with the brand merge — neither account has a real
  // logo asset yet, so the handle chip is text-only until Jackie supplies a UIU logo.
  const chipPadLeft = 22;
  const handleChipWidth = handleText.length * 17 + chipPadLeft + 22;
  const handleTextX = 48 + chipPadLeft + (handleChipWidth - chipPadLeft - 22) / 2;

  const svg = `<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0" />
      <stop offset="55%" stop-color="#000000" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.92" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1080" height="1080" fill="${palette.overlay}" />
  <image href="${bgDataUri}" x="0" y="0" width="1080" height="1080" preserveAspectRatio="xMidYMid slice" />
  <rect x="0" y="460" width="1080" height="620" fill="url(#grad)" />
  <rect x="48" y="48" width="${handleChipWidth}" height="54" rx="27" fill="rgba(0,0,0,0.45)" />
  <text x="${handleTextX}" y="83" font-family="Hook" font-weight="800" font-size="30" fill="${palette.accent}" text-anchor="middle">${handleText}</text>
  <text font-family="Hook" font-weight="800" font-size="${fontSize}" fill="${palette.text}" letter-spacing="-1">${hookTspans}</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
    font: { fontBuffers: [new Uint8Array(hookFontData)], defaultFontFamily: "Hook" },
  });
  return resvg.render().asPng();
}
