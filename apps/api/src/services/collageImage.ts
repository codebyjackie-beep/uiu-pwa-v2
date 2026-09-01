/**
 * cc_prompt_multiproduct_collage.md (2026-09-01) — Pattern 2 catalog-grid collage renderer for
 * the multi-product affiliate post type. Same SVG-hand-write + @cf-wasm/resvg/workerd approach
 * as services/brandedImage.ts (see that file's header for why: no satori/harfbuzz dependency
 * chain, one bundled font, resvg is the only rendering dependency) — shared helpers
 * (toDataUri/bytesToBase64/escapeXml/ensureWasm, the hook font) are imported from there rather
 * than duplicated.
 *
 * Fixed at 9 products / 3x3 grid for V1 (within the spec's 8-10 range) to avoid dynamic
 * grid-layout math on the first version — see cc_prompt_multiproduct_collage.md plan notes.
 * Uses UIU's own black/white/green palette (not services/brandedImage.ts's PALETTES.affiliate),
 * since this is a UIU-branded post, not a leftover-brand one.
 */
import { Resvg } from "@cf-wasm/resvg/workerd";
import hookFontData from "../../assets/hook-font.ttf";
import { toDataUri, escapeXml, ensureWasm } from "./brandedImage";

export interface CollageProductCell {
  imageUrl: string;
  productName: string;
  benefitLine: string;
}

export interface RenderCollageImageParams {
  headline: string;
  subtitle: string;
  products: CollageProductCell[]; // exactly 9, caller's responsibility
}

const CANVAS_W = 1080;
const CANVAS_H = 1350;
const GRID_COLS = 3;
const GRID_ROWS = 3;
const GRID_TOP = 220;
const GRID_BOTTOM = 1230;
const GRID_LEFT = 24;
const GRID_RIGHT = 1056;
const CELL_GAP = 12;

const ACCENT = "#16a34a";
const BG = "#0a0a0a";
const TEXT = "#ffffff";
const MUTED = "#c9c9c9";

/** Greedy word-wrap for a fixed-width cell caption — same approximation as brandedImage.ts's wrapHook. */
function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const avgCharWidth = fontSize * 0.56;
  const maxCharsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  const words = text.split(/\s+/).filter(Boolean);
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
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = last.length > maxCharsPerLine - 1 ? `${last.slice(0, maxCharsPerLine - 1)}…` : last;
  }
  return lines;
}

/** Renders a 1080x1350 IG post: headline band, 3x3 product grid (photo + name + benefit line), CTA bar. */
export async function renderCollageImage(params: RenderCollageImageParams): Promise<Uint8Array> {
  if (params.products.length !== GRID_COLS * GRID_ROWS) {
    throw new Error(`renderCollageImage expects exactly ${GRID_COLS * GRID_ROWS} products, got ${params.products.length}`);
  }

  const [photoDataUris] = await Promise.all([Promise.all(params.products.map((p) => toDataUri(p.imageUrl))), ensureWasm()]);

  const cellW = (GRID_RIGHT - GRID_LEFT - CELL_GAP * (GRID_COLS - 1)) / GRID_COLS;
  const cellH = (GRID_BOTTOM - GRID_TOP - CELL_GAP * (GRID_ROWS - 1)) / GRID_ROWS;
  const photoH = cellH * 0.68;
  const captionH = cellH - photoH;

  const cells = params.products
    .map((product, i) => {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const x = GRID_LEFT + col * (cellW + CELL_GAP);
      const y = GRID_TOP + row * (cellH + CELL_GAP);
      const photoY = y;
      const captionY = y + photoH;

      const nameLines = wrapText(product.productName, 20, cellW - 16, 2);
      const benefitLines = wrapText(product.benefitLine, 16, cellW - 16, 1);

      const nameTspans = nameLines
        .map((line, li) => `<tspan x="${x + cellW / 2}" y="${captionY + 22 + li * 22}">${escapeXml(line)}</tspan>`)
        .join("");
      const benefitY = captionY + 22 + nameLines.length * 22 + 16;
      const benefitTspans = benefitLines
        .map((line, li) => `<tspan x="${x + cellW / 2}" y="${benefitY + li * 18}">${escapeXml(line)}</tspan>`)
        .join("");

      return `
  <g>
    <rect x="${x}" y="${photoY}" width="${cellW}" height="${photoH}" fill="#151515" rx="10" />
    <clipPath id="cell-clip-${i}"><rect x="${x}" y="${photoY}" width="${cellW}" height="${photoH}" rx="10" /></clipPath>
    <image href="${photoDataUris[i]}" x="${x}" y="${photoY}" width="${cellW}" height="${photoH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cell-clip-${i})" />
    <rect x="${x}" y="${captionY}" width="${cellW}" height="${captionH}" fill="#141414" rx="10" />
    <text font-family="Hook" font-weight="700" font-size="20" fill="${TEXT}" text-anchor="middle">${nameTspans}</text>
    <text font-family="Hook" font-weight="500" font-size="16" fill="${MUTED}" text-anchor="middle">${benefitTspans}</text>
  </g>`;
    })
    .join("");

  const headlineLines = wrapText(params.headline, 52, CANVAS_W - 112, 2);
  const headlineTspans = headlineLines
    .map((line, i) => `<tspan x="${CANVAS_W / 2}" y="${88 + i * 58}">${escapeXml(line)}</tspan>`)
    .join("");
  const subtitleY = 88 + headlineLines.length * 58 + 30;

  const svg = `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="${BG}" />
  <text font-family="Hook" font-weight="800" font-size="52" fill="${TEXT}" text-anchor="middle" letter-spacing="-1">${headlineTspans}</text>
  <text x="${CANVAS_W / 2}" y="${subtitleY}" font-family="Hook" font-weight="600" font-size="26" fill="${ACCENT}" text-anchor="middle">${escapeXml(params.subtitle)}</text>
  ${cells}
  <rect x="0" y="${CANVAS_H - 90}" width="${CANVAS_W}" height="90" fill="${ACCENT}" />
  <text x="${CANVAS_W / 2}" y="${CANVAS_H - 40}" font-family="Hook" font-weight="700" font-size="28" fill="${BG}" text-anchor="middle">Full list &amp; where to buy → useitup.uk/shop-affiliate</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CANVAS_W },
    font: { fontBuffers: [new Uint8Array(hookFontData)], defaultFontFamily: "Hook" },
  });
  return resvg.render().asPng();
}
