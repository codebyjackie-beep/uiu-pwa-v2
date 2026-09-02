/**
 * cc_prompt_multiproduct_collage.md (2026-09-01, Pattern 2 catalog-grid) then redesigned
 * 2026-09-02 per cc_prompt_multiproduct_collage.md's follow-up "moodboard cutout" prompt —
 * Jackie's read on the shipped v1 (dead-black background, hard 3x3 grid, white product boxes)
 * was that it read as a spreadsheet, not the high-engagement `#amazonhomefinds` collage style
 * she found on IG (warm neutral background, die-cut/cutout product photos, irregular layout,
 * serif display headline). This version keeps the same SVG-hand-write + @cf-wasm/resvg render
 * path (see original header note above — no satori/harfbuzz dependency chain) but:
 *   - swaps the black canvas for a warm cream background (UIU green stays as the only accent,
 *     not the reference's brown palette, so it's still recognizably UIU)
 *   - cuts each product photo out of its (usually white, per Amazon's own listing rules)
 *     background via services/cutoutImage.ts before placing it, falling back per-product to the
 *     old white-card treatment when a photo doesn't qualify for cutout (busy/non-white bg,
 *     decode failure, etc.) — see that file's header for why this is safe to attempt for every
 *     photo with no added cost/API key
 *   - lays tiles out on an irregular masonry (three columns, shortest-column-first, one larger
 *     "hero" tile, alternating rotation) instead of a fixed 3x3 grid, and drops per-tile
 *     product-name/benefit boxes down to a single unboxed caption line
 *   - headline now renders in a bundled serif display font (assets/collage-font.ttf, DM Serif
 *     Display, OFL — see collage-font.OFL.txt) instead of the sans "Hook" font, for the
 *     reference's "AMAZON / Chic Home Finds" look; captions and the CTA bar keep "Hook" (Poppins
 *     ExtraBold) since that's the only weight bundled and small caption text needs a plain face.
 *
 * Product grouping/LLM ideation/theme rotation (jobs/igContentAgent.ts, services/igContentGen.ts)
 * and caption/CTA copy are untouched by this prompt — only this renderer changed.
 */
import { Resvg } from "@cf-wasm/resvg/workerd";
import hookFontData from "../../assets/hook-font.ttf";
import collageFontData from "../../assets/collage-font.ttf";
import { toDataUri, escapeXml, ensureWasm } from "./brandedImage";
import { cutoutProductImage } from "./cutoutImage";

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
const GRID_TOP = 230;
const GRID_BOTTOM = 1220;
const GRID_LEFT = 50;
const GRID_RIGHT = 1030;
const COLS = 3;
const GAP = 18;
const CAPTION_H = 54; // reserved below each tile for the unboxed product-name line (up to 2 lines)

const ACCENT = "#16a34a";
const BG = "#F5EDE0"; // warm cream — replaces the old dead-black canvas
const TEXT_DARK = "#1a1a1a";
const MUTED = "#6b6152";
const CARD_WHITE = "#ffffff"; // fallback (non-cutout) product card only

/** Greedy word-wrap for a fixed-width caption/headline line — same approximation as brandedImage.ts's wrapHook. */
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

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: number;
}

const ROTATIONS = [-2.5, 2, -1.5, 2.5, -2, 1.5, -2.5, 2];

/**
 * Irregular masonry: 3 columns, shortest-column-first placement, one larger "hero" tile
 * (index 0) forced into column 0, alternating tile heights + small rotation for the
 * "moodboard/scrapbook" feel the prompt asked for. Two-pass: simulate at nominal size first,
 * then scale tile heights down (never up) if the simulated layout would overflow the
 * available vertical space, so this still works if product count/region size ever changes.
 */
function buildMoodboardLayout(count: number): Tile[] {
  const availW = GRID_RIGHT - GRID_LEFT;
  const availH = GRID_BOTTOM - GRID_TOP;
  const colW = (availW - GAP * (COLS - 1)) / COLS;

  const nominal: Array<{ w: number; h: number; rotate: number; col?: number }> = [];
  nominal.push({ w: colW, h: colW * 1.55, rotate: 0, col: 0 }); // hero
  for (let i = 1; i < count; i++) {
    const h = colW * (i % 2 === 0 ? 0.95 : 1.2);
    nominal.push({ w: colW, h, rotate: ROTATIONS[(i - 1) % ROTATIONS.length]! });
  }

  const place = (scale: number): { tiles: Tile[]; requiredH: number } => {
    const colHeights = [0, 0, 0];
    const tiles: Tile[] = [];
    for (const spec of nominal) {
      const h = spec.h * scale;
      const w = spec.w;
      const col = spec.col ?? colHeights.indexOf(Math.min(...colHeights));
      const x = GRID_LEFT + col * (colW + GAP);
      const y = GRID_TOP + colHeights[col]!;
      tiles.push({ x, y, w, h, rotate: spec.rotate });
      colHeights[col] = colHeights[col]! + h + GAP + CAPTION_H;
    }
    return { tiles, requiredH: Math.max(...colHeights) };
  };

  const dryRun = place(1);
  const scale = dryRun.requiredH > availH ? Math.max(0.55, availH / dryRun.requiredH) : 1;
  return scale === 1 ? dryRun.tiles : place(scale).tiles;
}

/** One tile: cutout sticker (contain-fit, drop shadow, rotated) or fallback white photo card (cover-fit, unrotated for readability). */
function renderTile(tile: Tile, index: number, photo: { dataUri: string; width: number; height: number } | null, isCutout: boolean, caption: string): string {
  const cx = tile.x + tile.w / 2;
  const cy = tile.y + tile.h / 2;
  const captionY = tile.y + tile.h + 20;
  const captionLines = wrapText(caption, 17, tile.w + 24, 2);
  const captionTspans = captionLines.map((line, li) => `<tspan x="${cx}" y="${captionY + li * 21}">${escapeXml(line)}</tspan>`).join("");
  const captionSvg = captionLines.length
    ? `<text font-family="Hook" font-weight="700" font-size="17" fill="${TEXT_DARK}" text-anchor="middle">${captionTspans}</text>`
    : "";

  if (!photo) {
    // Should not happen (toDataUri throws on fetch failure), but keep the tile visually inert rather than crash the batch.
    return `<g><rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="14" fill="${CARD_WHITE}" />${captionSvg}</g>`;
  }

  if (isCutout) {
    // Contain-fit inside the tile box so the die-cut silhouette isn't cropped, then rotate the whole sticker (photo + its own shadow) about the tile center.
    const scale = Math.min(tile.w / photo.width, tile.h / photo.height);
    const w = photo.width * scale;
    const h = photo.height * scale;
    const x = cx - w / 2;
    const y = cy - h / 2;
    return `
  <g transform="rotate(${tile.rotate} ${cx} ${cy})">
    <rect x="${x - 6}" y="${y - 6 + 10}" width="${w + 12}" height="${h + 12}" fill="#000000" opacity="0.14" filter="url(#tileShadow)" />
    <image href="${photo.dataUri}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />
  </g>
  ${captionSvg}`;
  }

  // Fallback: old rounded white card, cover-fit photo, no rotation (keeps the fallback legible/predictable).
  return `
  <g>
    <rect x="${tile.x - 4}" y="${tile.y + 6}" width="${tile.w + 8}" height="${tile.h + 8}" rx="16" fill="#000000" opacity="0.10" filter="url(#tileShadow)" />
    <rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="14" fill="${CARD_WHITE}" />
    <clipPath id="cell-clip-${index}"><rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="14" /></clipPath>
    <image href="${photo.dataUri}" x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cell-clip-${index})" />
  </g>
  ${captionSvg}`;
}

/** Renders a 1080x1350 IG post: serif headline band, irregular moodboard of cutout/fallback product tiles, CTA bar. */
export async function renderCollageImage(params: RenderCollageImageParams): Promise<Uint8Array> {
  const count = params.products.length;
  if (count < 8 || count > 10) {
    throw new Error(`renderCollageImage expects 8-10 products, got ${count}`);
  }

  const [photos] = await Promise.all([
    Promise.all(
      params.products.map(async (p) => {
        const cutout = await cutoutProductImage(p.imageUrl);
        if (cutout) return { photo: cutout, isCutout: true as const };
        const dataUri = await toDataUri(p.imageUrl);
        // Fallback path doesn't know pixel dimensions (toDataUri doesn't decode) — renderTile only
        // needs width/height for the cutout's contain-fit math, so a placeholder is fine here.
        return { photo: { dataUri, width: 0, height: 0 }, isCutout: false as const };
      }),
    ),
    ensureWasm(),
  ]);

  const tiles = buildMoodboardLayout(count);
  const cutoutCount = photos.filter((p) => p.isCutout).length;
  console.log(`[uiu-api] renderCollageImage: ${cutoutCount}/${count} product photos cut out, ${count - cutoutCount} used the fallback card`);

  const tilesSvg = tiles
    .map((tile, i) => {
      const p = photos[i]!;
      return renderTile(tile, i, p.photo, p.isCutout, params.products[i]!.productName);
    })
    .join("");

  const headlineLines = wrapText(params.headline, 58, CANVAS_W - 112, 2);
  const headlineTspans = headlineLines
    .map((line, i) => `<tspan x="${CANVAS_W / 2}" y="${92 + i * 62}">${escapeXml(line)}</tspan>`)
    .join("");
  const subtitleY = 92 + headlineLines.length * 62 + 28;

  const svg = `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="tileShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6" />
    </filter>
  </defs>
  <rect x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="${BG}" />
  <text font-family="DM Serif Display" font-size="58" fill="${TEXT_DARK}" text-anchor="middle">${headlineTspans}</text>
  <text x="${CANVAS_W / 2}" y="${subtitleY}" font-family="Hook" font-weight="700" font-size="24" fill="${ACCENT}" text-anchor="middle">${escapeXml(params.subtitle)}</text>
  ${tilesSvg}
  <rect x="0" y="${CANVAS_H - 90}" width="${CANVAS_W}" height="90" fill="${ACCENT}" />
  <text x="${CANVAS_W / 2}" y="${CANVAS_H - 40}" font-family="Hook" font-weight="700" font-size="28" fill="${BG}" text-anchor="middle">Full list &amp; where to buy &gt;&gt; useitup.uk/shop-affiliate</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CANVAS_W },
    font: {
      fontBuffers: [new Uint8Array(hookFontData), new Uint8Array(collageFontData)],
      defaultFontFamily: "Hook",
    },
  });
  return resvg.render().asPng();
}
