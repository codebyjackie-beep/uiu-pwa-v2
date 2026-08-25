/**
 * 2026-08-25 addendum — live-verified bug (Jackie caught it via the Telegram review bot):
 * affiliate posts came out with the hook/handle text floating on a solid black square, no
 * background photo. Root cause: `renderBrandedImage()`'s SVG rasterizer (`@cf-wasm/resvg`,
 * see that file) silently drops any `<image>` element it can't decode — no error, no log,
 * it just doesn't paint it, leaving the base `<rect fill="#0a0a0a">` visible underneath.
 * Its bundled `image` crate does not support WebP. Google's cached shopping-thumbnail proxy
 * (`encrypted-tbn*.gstatic.com/shopping`, the primary source for affiliate product photos —
 * see services/serper.ts searchProductImage) always serves `image/webp` regardless of the
 * `Accept` header sent (confirmed live). Organic posts use Pexels JPEGs and were never
 * affected.
 *
 * Fix: transcode WebP -> PNG here, in-Worker, before the image is embedded in the SVG, using
 * jSquash's WASM webp decoder + png encoder — same "WASM-only, no native/system deps"
 * approach as `@cf-wasm/resvg` itself, so this doesn't reintroduce the kind of dependency
 * complexity that motivated dropping satori.
 */
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import webpDecoderWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
// @jsquash/png ships its own wasm-bindgen-style .d.ts for this file (named function exports,
// as if already instantiated) which doesn't match what wrangler's `.wasm` import rule actually
// produces (a raw WebAssembly.Module, per our wasm.d.ts) — the runtime value is correct, only
// the package's bundled type is wrong for this build target.
// @ts-expect-error see comment above
import pngEncoderWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";

let webpInit: Promise<void> | null = null;
let pngInit: Promise<unknown> | null = null;

function ensureWebpDecoder(): Promise<void> {
  if (!webpInit) webpInit = initWebpDecode(webpDecoderWasm);
  return webpInit;
}

function ensurePngEncoder(): Promise<unknown> {
  if (!pngInit) pngInit = initPngEncode(pngEncoderWasm);
  return pngInit;
}

export async function webpToPng(bytes: Uint8Array): Promise<Uint8Array> {
  await Promise.all([ensureWebpDecoder(), ensurePngEncoder()]);
  const imageData = await decodeWebp(bytes.buffer as ArrayBuffer);
  const pngBuffer = await encodePng(imageData);
  return new Uint8Array(pngBuffer);
}
