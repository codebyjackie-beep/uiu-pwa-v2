/**
 * cc_prompt_atlas_cloud_bg.md — Atlas Cloud AI background image generation for IG posts,
 * replacing Pexels generic stock. Confirmed live against the real API 2026-09-02 rather than
 * assumed OpenAI-shaped (Jackie: "之前testing過幾次假設同官方API一樣結果撞板") — Atlas Cloud's
 * chat/completions endpoint IS OpenAI-compatible but image generation is a completely
 * different, ASYNC contract:
 *   1. POST /api/v1/model/generateImage {model, prompt, size, quality} -> {data:{id, status:"processing"}}
 *   2. Poll GET /api/v1/model/prediction/{id} until data.status is "completed" (observed
 *      12-20s latency for the mini tier) -> data.outputs[0] is the image URL.
 * The exact model-name string (`openai/gpt-image-1-mini/text-to-image`) was NOT taken from
 * scraped docs (several scraped pages disagreed with each other and 404'd) — it was read from
 * Atlas Cloud's own live catalog (GET /api/v1/models, type:"Image") and verified end-to-end
 * with a real generateImage call before this file was written.
 */
export interface AtlasCloudEnv {
  ATLAS_CLOUD_API_KEY: string;
}

const GENERATE_URL = "https://api.atlascloud.ai/api/v1/model/generateImage";
const PREDICTION_URL = (id: string) => `https://api.atlascloud.ai/api/v1/model/prediction/${id}`;

/** Cheapest text-to-image tier ($0.004/image at 1024x1024/low quality) — text is composited
 * separately (brandedImage.ts's hand-written SVG layer), so the pricier "accurate text
 * rendering" tiers buy nothing here. */
const MODEL = "openai/gpt-image-1-mini/text-to-image";
const ESTIMATED_COST_USD = 0.004;

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 20; // ~40s ceiling; observed completions land around 12-20s

interface GenerateImageResponse {
  code: number;
  data?: { id?: string };
}

interface PredictionResponse {
  code: number;
  data?: { status?: string; outputs?: string[] | null; error?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates one 1024x1024 AI background image from a natural-language scene description.
 * Returns null (never throws) on any failure — an Atlas Cloud outage/rate-limit must fall
 * back to the caller's existing Pexels/product-photo path, not break the whole IG batch.
 */
export async function generateBackgroundImage(env: AtlasCloudEnv, prompt: string): Promise<string | null> {
  try {
    const startRes = await fetch(GENERATE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ATLAS_CLOUD_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, size: "1024x1024", quality: "low" }),
    });
    if (!startRes.ok) throw new Error(`Atlas Cloud generateImage failed: ${startRes.status} ${startRes.statusText}`);
    const started = (await startRes.json()) as GenerateImageResponse;
    const predictionId = started.data?.id;
    if (!predictionId) throw new Error("Atlas Cloud generateImage response had no prediction id");

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(PREDICTION_URL(predictionId), { headers: { Authorization: `Bearer ${env.ATLAS_CLOUD_API_KEY}` } });
      if (!pollRes.ok) continue; // transient poll error — keep retrying within the attempt budget
      const polled = (await pollRes.json()) as PredictionResponse;
      const status = polled.data?.status;
      if (status === "completed" || status === "succeeded") {
        const url = polled.data?.outputs?.[0];
        if (!url) throw new Error("Atlas Cloud prediction completed with no output URL");
        console.log(`[uiu-api] atlasCloudImage: generated background image (~$${ESTIMATED_COST_USD.toFixed(3)}), prediction ${predictionId}`);
        return url;
      }
      if (status === "failed") throw new Error(`Atlas Cloud prediction failed: ${polled.data?.error ?? "unknown error"}`);
    }
    throw new Error(`Atlas Cloud prediction ${predictionId} did not complete within ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS}ms`);
  } catch (err) {
    console.error("[uiu-api] atlasCloudImage.generateBackgroundImage failed, caller falls back:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
