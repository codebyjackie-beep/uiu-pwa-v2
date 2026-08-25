/**
 * HANDOFF_ig-marketing-affiliate-agent-design.md — 2026-08-25 addendum (Jackie, after
 * reviewing live posts: "人哋睇個post唔會知你個張圖想講啲乜") — composites the post's
 * hook line onto its background photo, so the point of the post is visible in-feed
 * without a reader tapping "more". satori (JSX-shaped object -> SVG) + @resvg/resvg-wasm
 * (SVG -> PNG) both run natively in the Workers runtime (no new SaaS/API key).
 *
 * satori cannot fetch the background photo itself (it only embeds whatever `src` string
 * is given), and @resvg/resvg-wasm's renderer has no network access inside the wasm
 * sandbox — so the background image is fetched here and inlined as a base64 data: URI
 * before being handed to satori.
 */
import satori, { init as initSatori } from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import RESVG_WASM from "@resvg/resvg-wasm/index_bg.wasm";
import HARFBUZZ_WASM from "harfbuzzjs/hb.wasm";

export type BrandAccount = "uiu" | "affiliate";

interface Palette {
  /** Bottom gradient / handle-chip base — both accounts are dark per Jackie's brief (2026-08-22 CLAUDE.md §3 black/white/green). */
  overlay: string;
  accent: string;
  text: string;
  handle: string;
}

const PALETTES: Record<BrandAccount, Palette> = {
  // UIU: black bg, white text, UIU brand green accent (apps/web/app/globals.css --uiu-green).
  uiu: { overlay: "#0a0a0a", accent: "#16a34a", text: "#ffffff", handle: "@useitup.app" },
  // Affiliate (@kura.nook): same dark base, a distinct brighter green so the two accounts
  // are visually distinguishable — placeholder shade pending Jackie's exact KN logo hex.
  affiliate: { overlay: "#0a0a0a", accent: "#22c55e", text: "#ffffff", handle: "@kura.nook" },
};

const fontCache = new Map<string, Promise<ArrayBuffer>>();

/**
 * Standard "old Chrome User-Agent" trick (same technique @vercel/og uses) — Google Fonts'
 * css2 endpoint serves woff2 to modern UAs but plain .ttf to old ones, and satori/resvg need
 * a raw TTF/OTF, not woff2. Cached at module scope so a warm isolate only fetches once.
 */
function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const key = `${family}:${weight}`;
  let cached = fontCache.get(key);
  if (!cached) {
    cached = fetchGoogleFont(family, weight);
    fontCache.set(key, cached);
  }
  return cached;
}

/** Google now serves plain .woff (not .ttf) to this old-Chrome UA (Chrome 41 predates
 * woff2) — confirmed live 2026-08-25. satori/opentype.js parse .woff fine, so this no
 * longer insists on truetype/opentype; it just needs the "latin" subset block (the CSS
 * lists several unicode-range subsets — cyrillic/greek/vietnamese/etc. come first, latin
 * last), since that's the one covering plain English hook text. */
async function fetchGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36",
    },
  });
  if (!cssRes.ok) throw new Error(`Google Fonts CSS fetch failed: ${cssRes.status}`);
  const css = await cssRes.text();
  const blocks = css.split("@font-face").slice(1);
  const latinBlock = blocks.find((b) => b.includes("U+0000-00FF")) ?? blocks[blocks.length - 1];
  if (!latinBlock) throw new Error("Google Fonts CSS had no @font-face blocks");
  const match = latinBlock.match(/src: url\(([^)]+)\)/);
  if (!match) throw new Error("Google Fonts CSS latin block had no src url");
  const fontRes = await fetch(match[1]!);
  if (!fontRes.ok) throw new Error(`Google Fonts font fetch failed: ${fontRes.status}`);
  return fontRes.arrayBuffer();
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function toDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Background image fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

/**
 * Both wasm binaries must be explicitly pre-initialized in Workers — satori's default
 * harfbuzzjs loading path does `new URL('hb.wasm', import.meta.url)` internally, which
 * resolves to `undefined` under wrangler's bundler (confirmed live via `wrangler tail`:
 * "Cannot read properties of undefined (reading 'href')" thrown from harfbuzzjs's hb.js).
 * satori exports `init(wasmModule)` specifically to bypass that lookup — same pattern as
 * @resvg/resvg-wasm's initWasm() below, just two separate wasm binaries for two libraries.
 */
let wasmReady: Promise<void> | undefined;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = Promise.all([
      initWasm(RESVG_WASM as unknown as WebAssembly.Module),
      initSatori(HARFBUZZ_WASM as unknown as WebAssembly.Module),
    ]).then(() => undefined);
  }
  return wasmReady;
}

/** Hook font size shrinks as the hook gets longer so a ~125-char hook still fits the overlay band. */
function hookFontSize(hookLength: number): number {
  if (hookLength <= 55) return 66;
  if (hookLength <= 85) return 54;
  return 44;
}

export interface RenderBrandedImageParams {
  backgroundImageUrl: string;
  hook: string;
  account: BrandAccount;
}

/** Renders a 1080x1080 IG feed image: background photo + bottom gradient + hook headline + handle watermark. */
export async function renderBrandedImage(params: RenderBrandedImageParams): Promise<Uint8Array> {
  const palette = PALETTES[params.account];
  const [bgDataUri, fontData] = await Promise.all([toDataUri(params.backgroundImageUrl), loadGoogleFont("Inter", 800), ensureWasm()]);

  const tree = {
    type: "div",
    props: {
      style: {
        display: "flex",
        position: "relative",
        width: "1080px",
        height: "1080px",
        backgroundColor: palette.overlay,
        fontFamily: "Inter",
      },
      children: [
        {
          type: "img",
          props: {
            src: bgDataUri,
            width: 1080,
            height: 1080,
            style: { position: "absolute", top: "0px", left: "0px", width: "1080px", height: "1080px", objectFit: "cover" },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              position: "absolute",
              left: "0px",
              right: "0px",
              bottom: "0px",
              height: "620px",
              background: `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.92) 100%)`,
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              position: "absolute",
              top: "48px",
              left: "48px",
              padding: "12px 22px",
              borderRadius: "999px",
              backgroundColor: "rgba(0,0,0,0.45)",
              color: palette.accent,
              fontSize: "30px",
              fontWeight: 800,
            },
            children: palette.handle,
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              position: "absolute",
              left: "56px",
              right: "56px",
              bottom: "88px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    fontSize: `${hookFontSize(params.hook.length)}px`,
                    fontWeight: 800,
                    color: palette.text,
                    lineHeight: 1.18,
                    letterSpacing: "-1px",
                  },
                  children: params.hook,
                },
              },
            ],
          },
        },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 1080,
    height: 1080,
    fonts: [{ name: "Inter", data: fontData, weight: 800, style: "normal" }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } });
  return resvg.render().asPng();
}
