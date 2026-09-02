/**
 * cc_prompt_multiproduct_collage.md (2026-09-02 redesign) — background removal for collage
 * product photos, so they can be pasted onto the warm moodboard background as "stickers"
 * instead of sitting in a white box.
 *
 * Approach (option (a) from the prompt, chosen over (b) remove.bg): Amazon's own listing
 * policy requires main product images to sit on a pure white background
 * (https://sellercentral.amazon.co.uk main image requirements), and collageImage.ts's photos
 * are sourced from m.media-amazon.com or Google's shopping-thumbnail proxy — both usually
 * white/near-white already. So a plain corner-sampled flood fill is enough for the common
 * case and costs nothing per image (no third-party API/key). No native image libs exist in
 * Workers (no sharp) — decode/encode goes through the same jSquash WASM codecs
 * webpTranscode.ts already uses for WebP, plus @jsquash/jpeg for the Amazon JPEGs and
 * @jsquash/png/decode for the rare PNG source.
 *
 * Graceful fallback (required by the prompt): returns `null` whenever the source doesn't look
 * like a clean studio white-background shot (corners disagree, or aren't light/neutral enough)
 * or decoding fails for any reason — caller (collageImage.ts) falls back to the old white-card
 * treatment for that one product without failing the whole collage.
 */
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import jpegDecoderWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import webpDecoderWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
// @ts-expect-error see comment above
import pngCodecWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";

let jpegInit: Promise<void> | null = null;
let webpInit: Promise<void> | null = null;
let pngDecodeInit: Promise<unknown> | null = null;
let pngEncodeInit: Promise<unknown> | null = null;

function ensureJpegDecoder(): Promise<void> {
  if (!jpegInit) jpegInit = initJpegDecode(jpegDecoderWasm as unknown as WebAssembly.Module);
  return jpegInit;
}
function ensureWebpDecoder(): Promise<void> {
  if (!webpInit) webpInit = initWebpDecode(webpDecoderWasm);
  return webpInit;
}
function ensurePngDecoder(): Promise<unknown> {
  if (!pngDecodeInit) pngDecodeInit = initPngDecode(pngCodecWasm);
  return pngDecodeInit;
}
function ensurePngEncoder(): Promise<unknown> {
  if (!pngEncodeInit) pngEncodeInit = initPngEncode(pngCodecWasm);
  return pngEncodeInit;
}

export interface CutoutResult {
  /** Transparent PNG, cropped tight to the non-background content (plus a small pad), as a data: URI. */
  dataUri: string;
  width: number;
  height: number;
}

const CORNER_SAMPLE = 6; // px square sampled at each of the 4 corners to estimate bg color
const BG_MIN_CHANNEL = 232; // corners must be this light...
const BG_MAX_SPREAD = 18; // ...and this close to neutral (max channel - min channel) to qualify
const FLOOD_DISTANCE = 42; // per-channel-ish distance budget for "same as background"
const MIN_REMOVED_FRACTION = 0.02; // below this, there's no real background to speak of
const MAX_REMOVED_FRACTION = 0.97; // above this, flood fill likely ate the product itself

type Decoded = { width: number; height: number; data: Uint8ClampedArray };

async function decodeImage(bytes: Uint8Array, contentType: string): Promise<Decoded> {
  const buf = bytes.buffer as ArrayBuffer;
  if (contentType === "image/webp") {
    await ensureWebpDecoder();
    return (await decodeWebp(buf)) as Decoded;
  }
  if (contentType === "image/png") {
    await ensurePngDecoder();
    return (await decodePng(buf)) as Decoded;
  }
  // Default: Amazon/Google product photos that aren't webp/png are jpeg in practice.
  await ensureJpegDecoder();
  return (await decodeJpeg(buf)) as Decoded;
}

function cornerColor(img: Decoded): [number, number, number] | null {
  const { width, height, data } = img;
  const n = Math.min(CORNER_SAMPLE, width, height);
  const corners: [number, number][] = [
    [0, 0],
    [width - n, 0],
    [0, height - n],
    [width - n, height - n],
  ];
  let r = 0, g = 0, b = 0, count = 0;
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + n; y++) {
      for (let x = cx; x < cx + n; x++) {
        const i = (y * width + x) * 4;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        count++;
      }
    }
  }
  r /= count;
  g /= count;
  b /= count;
  const minC = Math.min(r, g, b);
  const maxC = Math.max(r, g, b);
  if (minC < BG_MIN_CHANNEL || maxC - minC > BG_MAX_SPREAD) return null;
  return [r, g, b];
}

/** Iterative 4-connected flood fill from every border pixel that matches bgColor; marks matches in `bg`. */
function floodFillBackground(img: Decoded, bgColor: [number, number, number]): Uint8Array {
  const { width, height, data } = img;
  const [br, bgc, bb] = bgColor;
  const bg = new Uint8Array(width * height); // 1 = background
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const matches = (idx: number): boolean => {
    const i = idx * 4;
    const dr = data[i]! - br;
    const dg = data[i + 1]! - bgc;
    const db = data[i + 2]! - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= FLOOD_DISTANCE;
  };

  const pushIfMatch = (idx: number) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    if (matches(idx)) stack.push(idx);
  };

  for (let x = 0; x < width; x++) {
    pushIfMatch(x); // top row
    pushIfMatch((height - 1) * width + x); // bottom row
  }
  for (let y = 0; y < height; y++) {
    pushIfMatch(y * width); // left col
    pushIfMatch(y * width + (width - 1)); // right col
  }

  while (stack.length) {
    const idx = stack.pop()!;
    bg[idx] = 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) pushIfMatch(idx - 1);
    if (x < width - 1) pushIfMatch(idx + 1);
    if (y > 0) pushIfMatch(idx - width);
    if (y < height - 1) pushIfMatch(idx + width);
  }

  return bg;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Attempts to cut a product out of its white/near-white studio background. Returns `null` (no
 * throw) whenever the source doesn't qualify or anything about the process fails — caller must
 * fall back to the original photo, per cc_prompt_multiproduct_collage.md's explicit
 * "graceful fallback, don't block the batch" requirement.
 */
export async function cutoutProductImage(url: string): Promise<CutoutResult | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const img = await decodeImage(bytes, contentType);

    const bgColor = cornerColor(img);
    if (!bgColor) return null;

    const bg = floodFillBackground(img, bgColor);
    const total = img.width * img.height;
    let removed = 0;
    for (let i = 0; i < total; i++) if (bg[i]) removed++;
    const removedFraction = removed / total;
    if (removedFraction < MIN_REMOVED_FRACTION || removedFraction > MAX_REMOVED_FRACTION) return null;

    const out = new Uint8ClampedArray(img.data);
    let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const idx = y * img.width + x;
        if (bg[idx]) {
          out[idx * 4 + 3] = 0;
        } else {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null; // nothing left — shouldn't happen given the fraction check above

    const pad = 4;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(img.width - 1, maxX + pad);
    maxY = Math.min(img.height - 1, maxY + pad);
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const cropped = new Uint8ClampedArray(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      const srcRowStart = ((minY + y) * img.width + minX) * 4;
      const dstRowStart = y * cropW * 4;
      cropped.set(out.subarray(srcRowStart, srcRowStart + cropW * 4), dstRowStart);
    }

    await ensurePngEncoder();
    // encodePng's declared param type is the DOM `ImageData` interface, which isn't in this
    // Worker's lib (no `dom` in tsconfig) — same shape-only mismatch webpTranscode.ts's
    // `decodeWebp`/`encodePng` pairing already lives with, just spelled out explicitly here
    // because this object is constructed locally instead of flowing straight from a decode call.
    const pngBuffer = await encodePng({ width: cropW, height: cropH, data: cropped } as unknown as Parameters<typeof encodePng>[0]);
    const png = new Uint8Array(pngBuffer);
    return { dataUri: `data:image/png;base64,${bytesToBase64(png)}`, width: cropW, height: cropH };
  } catch {
    return null;
  }
}
