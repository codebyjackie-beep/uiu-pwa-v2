/**
 * HANDOFF_fridge-followup.md #2/#4 — receipt OCR + fridge photo scan, both via
 * OpenRouter's Gemini 2.5 Flash-Lite vision model (shares OPENROUTER_API_KEY
 * with the daily recipe draft agent — see services/openrouter.ts — but a
 * separate [vars] model id so the two don't collide if either changes).
 */
import type { DraftedRecipe } from "./openrouter";

export interface OpenRouterVisionEnv {
  OPENROUTER_API_KEY: string;
  OPENROUTER_VISION_MODEL: string;
  OPENROUTER_RECEIPT_MODEL?: string;
  /** Video recipe import only (Jackie 2026-10-27: flash-lite/flash ~1/3 reliable on video; pro ~2/3). */
  OPENROUTER_VIDEO_MODEL?: string;
}

export interface ScannedItem {
  name: string;
  quantity: number | null;
  /** Model's estimate of how many days the item keeps from purchase (1–365), or null. */
  shelfLifeDays: number | null;
}

export interface ScanResult {
  items: ScannedItem[];
  /** Receipt purchase date as YYYY-MM-DD when the model read one (validated by the caller), else null. */
  purchaseDate: string | null;
  /** The date exactly as printed (receipts only) — parsed in code by the caller. Not sent to the client. */
  purchaseDateText?: string | null;
  /** Receipts only: the item total the receipt prints ("Items Sold: 12"), or null. Used by the caller's count check. */
  itemsSold?: number | null;
  /** Receipts only: non-food lines the model left out, with the signed printed price (negative for discounts). Used by the caller's count check. */
  excluded?: { name: string; price: number | null }[];
  /** Receipts only: itemsSold vs how many items we found (after filtering). Set by the caller; null when unavailable. */
  countCheck?: { itemsSold: number; found: number } | null;
}

/** Why a scan failed: upstream = OpenRouter HTTP error, empty = no reply text, parse = reply was not the JSON we asked for. */
export class VisionError extends Error {
  readonly kind: "upstream" | "empty" | "parse";
  constructor(kind: "upstream" | "empty" | "parse", message: string) {
    super(message);
    this.kind = kind;
    this.name = "VisionError";
  }
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Model added prose around the JSON: take the outermost {...} or [...] span.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw err;
  }
}

export async function scanImageForItems(
  env: OpenRouterVisionEnv,
  imageDataUrl: string,
  prompt: string,
  modelOverride?: string,
): Promise<ScanResult> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelOverride ?? env.OPENROUTER_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new VisionError("upstream", `OpenRouter vision request failed: ${res.status} ${res.statusText} ${detail}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: { message?: string } };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new VisionError("empty", `OpenRouter vision response had no message content (finish_reason=${json.choices?.[0]?.finish_reason ?? "?"}, error=${json.error?.message ?? "-"})`);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    throw new VisionError("parse", `Vision reply was not JSON: ${content.slice(0, 300)}`);
  }
  // Receipts answer {"purchaseDate", "items": [...]}; fridge photos answer a bare array.
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(obj?.items) ? (obj!.items as unknown[]) : null;
  if (!list) throw new VisionError("parse", `Vision reply had no item list: ${content.slice(0, 300)}`);
  const purchaseDate = typeof obj?.purchaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.purchaseDate) ? obj.purchaseDate : null;

  const items = list
    .map((raw): ScannedItem | null => {
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const name = r.name;
      const quantity = r.quantity;
      const days = typeof r.shelfLifeDays === "number" && Number.isFinite(r.shelfLifeDays) ? Math.round(r.shelfLifeDays) : null;
      if (typeof name !== "string" || !name.trim()) return null;
      return {
        name: name.trim(),
        quantity: typeof quantity === "number" ? quantity : null,
        shelfLifeDays: days !== null && days >= 1 && days <= 365 ? days : null,
      };
    })
    .filter((item): item is ScannedItem => item !== null);
  const purchaseDateText = typeof obj?.purchaseDateText === "string" ? obj.purchaseDateText.slice(0, 40) : null;
  // Counts are only trusted as whole numbers in a sane range; anything else is treated as "not printed".
  const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 500 ? (v as number) : null);
  const excluded: { name: string; price: number | null }[] = Array.isArray(obj?.excluded)
    ? (obj!.excluded as unknown[])
        .map((raw): { name: string; price: number | null } | null => {
          // A bare string is accepted as a line with no known price.
          if (typeof raw === "string") return { name: raw.trim().slice(0, 80), price: null };
          if (!raw || typeof raw !== "object") return null;
          const r = raw as Record<string, unknown>;
          if (typeof r.name !== "string") return null;
          const price = typeof r.price === "number" && Number.isFinite(r.price) ? r.price : null;
          return { name: r.name.trim().slice(0, 80), price };
        })
        .filter((e): e is { name: string; price: number | null } => e !== null && e.name !== "")
        .slice(0, 50)
    : [];
  return { items, purchaseDate, purchaseDateText, itemsSold: count(obj?.itemsSold), excluded };
}

export interface MealNutritionEstimate {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  description: string;
}

const MEAL_NUTRITION_PROMPT =
  "Look at this photo of a meal. Estimate its total nutrition and give it a short description. " +
  "Respond with ONLY a JSON object, no markdown fences, no commentary: " +
  '{"calories": number, "protein": number, "carbs": number, "fat": number, "description": string}. ' +
  "protein/carbs/fat are grams. If you cannot identify any food in the photo, respond with " +
  '{"calories": 0, "protein": 0, "carbs": 0, "fat": 0, "description": "Could not identify food in photo"}.';

/** HANDOFF_health-tab-v1.md Part A — same OpenRouter/Gemini vision stack as
 * fridge-stock's OCR/scan-fridge above, different prompt shape (single object,
 * not an item array). */
export async function estimateMealNutrition(env: OpenRouterVisionEnv, imageDataUrl: string): Promise<MealNutritionEstimate> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: MEAL_NUTRITION_PROMPT },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new VisionError("upstream", `OpenRouter vision request failed: ${res.status} ${res.statusText} ${detail}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: { message?: string } };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new VisionError("empty", `OpenRouter vision response had no message content (finish_reason=${json.choices?.[0]?.finish_reason ?? "?"}, error=${json.error?.message ?? "-"})`);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    // Health data is secret-tier: never put the meal reply into an error/log line.
    throw new VisionError("parse", "Meal vision reply was not JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("OpenRouter vision response was not a JSON object");
  const raw = parsed as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
  return {
    calories: num(raw.calories),
    protein: num(raw.protein),
    carbs: num(raw.carbs),
    fat: num(raw.fat),
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : "Unknown meal",
  };
}

const PHOTO_RECIPE_PROMPT_PREFIX = (count: number) =>
  `These ${count} photo${count > 1 ? "s" : ""} show the same handwritten or printed recipe (possibly the front ` +
  `and back of a recipe card, or facing pages of a notebook) — combine them into one complete recipe. Transcribe ` +
  "the handwritten/printed text into structured JSON. " +
  "Regardless of what language the source text is written in (Chinese, Cantonese, or any other language), " +
  "translate the title, description, ingredient names, and steps into English. Do not leave any part of the " +
  "output in the original language. " +
  `Each ingredient's "name" field MUST contain ONLY the ingredient's name — never a quantity, a unit word, ` +
  `a quantity range, or any instruction/parenthetical text. Put every number and unit (including ranges ` +
  `like "3 to 5" or count words like "pcs"/"pieces") into "quantity"/"unit" instead. If handwriting is ` +
  `illegible for a given word, do not guess a single stray letter as the ingredient name — omit that ` +
  `ingredient line entirely rather than transcribing a fragment. ` +
  "Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape: " +
  '{"title": string, "description": string, "ingredients": [{"name": string, "quantity": number, "unit": string}], ' +
  '"steps": [string], "tags": [string], "mealType": string, "servings": number, "prepTimeMinutes": number, "cookTimeMinutes": number}. ' +
  'If the photo(s) are illegible or do not show a recipe, respond with {"title": "", "description": "", "ingredients": [], ' +
  '"steps": [], "tags": [], "servings": 0, "prepTimeMinutes": 0, "cookTimeMinutes": 0}.';

/** HANDOFF_recipe-photo-import.md — OCR + structure 1-3 photos of a
 * handwritten/printed recipe into DraftedRecipe shape. Returns null
 * (not a throw) when the photo(s) don't look like a legible recipe —
 * caller falls back to the existing Tier 3 manual-paste flow. */
export async function extractRecipeFromPhotos(env: OpenRouterVisionEnv, imageDataUrls: string[]): Promise<DraftedRecipe | null> {
  if (imageDataUrls.length === 0) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PHOTO_RECIPE_PROMPT_PREFIX(imageDataUrls.length) },
              ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = extractJson(content) as Partial<DraftedRecipe>;
    if (!parsed.title || !Array.isArray(parsed.ingredients) || parsed.ingredients.length < 2 || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    return {
      title: parsed.title,
      description: parsed.description ?? "",
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      mealType: parsed.mealType,
      servings: parsed.servings ?? 2,
      prepTimeMinutes: parsed.prepTimeMinutes ?? 0,
      cookTimeMinutes: parsed.cookTimeMinutes ?? 0,
    };
  } catch (err) {
    console.error("[uiu-api] extractRecipeFromPhotos failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

const VIDEO_RECIPE_PROMPT =
  "Watch and listen to this cooking video (it may be an Instagram, TikTok or YouTube clip). Write down the recipe " +
  "it actually shows: ingredients and amounts from what is said, shown on screen (captions, text overlays) or " +
  "clearly visible, and the steps in the order they happen. Do not invent ingredients that are not shown or " +
  "mentioned; when an amount is not given, estimate a sensible home-cook amount. " +
  "Regardless of what language is spoken or written (Cantonese, Mandarin, or any other language), write the " +
  "title, description, ingredient names and steps in English (UK spelling). " +
  `Each ingredient's "name" field MUST contain ONLY the ingredient's name — put every number and unit into ` +
  '"quantity"/"unit". Use metric units (g, ml) or counts (pcs, tbsp, tsp). ' +
  "Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape: " +
  '{"title": string, "description": string, "ingredients": [{"name": string, "quantity": number, "unit": string}], ' +
  '"steps": [string], "tags": [string], "mealType": string, "servings": number, "prepTimeMinutes": number, "cookTimeMinutes": number}. ' +
  'If the video does not show a recipe, respond with {"title": "", "description": "", "ingredients": [], "steps": [], ' +
  '"tags": [], "servings": 0, "prepTimeMinutes": 0, "cookTimeMinutes": 0}.';

/** Jackie 2026-10-25 — "Upload a video": the user uploads a recipe video from their phone (e.g. a reel they
 * saved); the video model watches + listens and drafts the recipe. Returns null (not a throw) when the video
 * shows no usable recipe, so the caller can fall back to manual paste. */
export async function extractRecipeFromVideo(env: OpenRouterVisionEnv, videoDataUrl: string): Promise<DraftedRecipe | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_VIDEO_MODEL ?? env.OPENROUTER_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VIDEO_RECIPE_PROMPT },
              { type: "video_url", video_url: { url: videoDataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("[uiu-api] extractRecipeFromVideo: OpenRouter", res.status, (await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = extractJson(content) as Partial<DraftedRecipe>;
    if (!parsed.title || !Array.isArray(parsed.ingredients) || parsed.ingredients.length < 2 || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }
    return {
      title: parsed.title,
      description: parsed.description ?? "",
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      mealType: parsed.mealType,
      servings: parsed.servings ?? 2,
      prepTimeMinutes: parsed.prepTimeMinutes ?? 0,
      cookTimeMinutes: parsed.cookTimeMinutes ?? 0,
    };
  } catch (err) {
    console.error("[uiu-api] extractRecipeFromVideo failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Diagnostics for /api/admin/video-test: the same call as extractRecipeFromVideo, but says WHY it gave up. */
export async function diagnoseVideoRecipe(env: OpenRouterVisionEnv, videoDataUrl: string, model?: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model ?? env.OPENROUTER_VIDEO_MODEL ?? env.OPENROUTER_VISION_MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: VIDEO_RECIPE_PROMPT }, { type: "video_url", video_url: { url: videoDataUrl } }] }],
      response_format: { type: "json_object" },
    }),
  });
  const raw = await res.text();
  if (!res.ok) return { stage: "http", status: res.status, body: raw.slice(0, 400) };
  let json: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: unknown };
  try {
    json = JSON.parse(raw);
  } catch {
    return { stage: "envelope", body: raw.slice(0, 300) };
  }
  const content = json.choices?.[0]?.message?.content ?? "";
  const finish = json.choices?.[0]?.finish_reason ?? null;
  if (!content) return { stage: "empty", finish, error: json.error ?? null };
  let parsed: Partial<DraftedRecipe>;
  try {
    parsed = extractJson(content) as Partial<DraftedRecipe>;
  } catch {
    return { stage: "not-json", finish, head: content.slice(0, 300) };
  }
  const ings = Array.isArray(parsed.ingredients) ? parsed.ingredients.length : -1;
  const steps = Array.isArray(parsed.steps) ? parsed.steps.length : -1;
  const ok = !!parsed.title && ings >= 2 && steps > 0;
  return { stage: ok ? "ok" : "fails-gate", finish, title: parsed.title ?? null, ingredients: ings, steps, keys: Object.keys(parsed) };
}
