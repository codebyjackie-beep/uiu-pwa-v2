/**
 * HANDOFF_recipe-social-import.md — social-link recipe import, §0/§2.
 * Three-tier fallback: JSON-LD (Tier 1, no AI) -> platform oEmbed caption + LLM
 * parse (Tier 2) -> manual paste + LLM parse (Tier 3, front-end driven). Every
 * network/parse step here must be caught by the caller (route) and treated as
 * "this tier failed", never allowed to bubble into a 500.
 */
import type { RecipeDraft } from "@uiu/shared";
import type { DraftedRecipe, OpenRouterEnv } from "./openrouter";

export interface OembedEnv {
  YOUTUBE_API_KEY?: string;
}

const FETCH_HEADERS = {
  // Some recipe blogs block requests with no browser-like UA.
  "User-Agent": "Mozilla/5.0 (compatible; UseItUpRecipeImport/1.0; +https://useitup.uk)",
  Accept: "text/html,application/xhtml+xml",
};

export function detectPlatform(url: string): RecipeDraft["sourcePlatform"] {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes("tiktok.com")) return "tiktok";
  if (host.includes("instagram.com")) return "instagram";
  if (host.includes("facebook.com") || host.includes("fb.watch")) return "facebook";
  if (host.includes("pinterest.")) return "pinterest";
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
  return null;
}

// ---------------------------------------------------------------------------
// Tier 1 — schema.org Recipe JSON-LD
// ---------------------------------------------------------------------------

/** Parses "PT15M" / "PT1H30M" -> minutes. Returns 0 for anything unparseable. */
function parseIsoDurationMinutes(value: unknown): number {
  if (typeof value !== "string") return 0;
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return 0;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + minutes;
}

function parseYield(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.round(value));
  if (Array.isArray(value)) return parseYield(value[0]);
  if (typeof value === "string") {
    const m = value.match(/\d+/);
    if (m) return Math.max(1, parseInt(m[0], 10));
  }
  return 2;
}

function instructionsToSteps(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return value
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          if (typeof (item as Record<string, unknown>).text === "string") return ((item as Record<string, unknown>).text as string).trim();
          if (Array.isArray((item as Record<string, unknown>).itemListElement)) {
            return instructionsToSteps((item as Record<string, unknown>).itemListElement).join(" ");
          }
        }
        return "";
      })
      .filter(Boolean);
  }
  return [];
}

// Fraction words / unicode vulgar fractions used by recipe sites.
const UNICODE_FRACTIONS: Record<string, number> = {
  "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

/** Best-effort split of a free-text ingredient line ("2 cups diced tomatoes") into
 * {quantity, unit, name}. Deliberately simple — downstream costRecipe()/resolver
 * only need a reasonable name + unit to attempt a match, this doesn't have to be perfect. */
function parseIngredientLine(raw: string): { name: string; quantity: number; unit: string } {
  let text = raw.trim();
  // Normalise unicode fractions like "1½" or standalone "½" into decimal.
  for (const [glyph, value] of Object.entries(UNICODE_FRACTIONS)) {
    text = text.replace(new RegExp(`(\\d+)\\s*${glyph}`), (_m, whole: string) => String(parseInt(whole, 10) + value));
    text = text.replace(new RegExp(glyph), String(value));
  }

  const m = text.match(/^([\d.]+(?:\s*\/\s*\d+)?)\s*(?:-\s*[\d.]+)?\s*([a-zA-Z]+\.?)?\s*(.*)$/);
  if (!m) return { name: text, quantity: 0, unit: "" };

  let quantity = 0;
  const qtyRaw = m[1];
  if (qtyRaw) {
    if (qtyRaw.includes("/")) {
      const [num, den] = qtyRaw.split("/").map((s) => parseFloat(s.trim()));
      quantity = den ? num! / den : 0;
    } else {
      quantity = parseFloat(qtyRaw);
    }
  }
  const unit = (m[2] ?? "").replace(/\.$/, "").toLowerCase();
  const name = (m[3] ?? "").trim() || text;

  // Bare adjectives aren't real units — treat as part of the name, unit stays "".
  const KNOWN_UNIT_WORDS = new Set([
    "tsp", "teaspoon", "teaspoons", "t", "tbsp", "tablespoon", "tablespoons", "tbs",
    "cup", "cups", "c", "floz", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
    "g", "gram", "grams", "kg", "kilogram", "kilograms", "ml", "l", "liter", "litre",
    "cl", "pint", "quart", "clove", "cloves", "can", "cans", "stalk", "stalks",
    "piece", "pieces", "slice", "slices", "pinch", "pinches", "dash", "dashes", "handful",
    "bunch", "head", "sprig", "sprigs", "packet", "package", "bag", "box", "container", "stick",
  ]);
  if (unit && !KNOWN_UNIT_WORDS.has(unit)) {
    return { name: `${unit} ${name}`.trim(), quantity, unit: "" };
  }
  return { name: name || text, quantity, unit };
}

interface JsonLdRecipe {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  recipeIngredient?: unknown;
  recipeInstructions?: unknown;
  recipeYield?: unknown;
  prepTime?: unknown;
  cookTime?: unknown;
}

function isRecipeType(node: unknown): node is JsonLdRecipe {
  if (!node || typeof node !== "object") return false;
  const type = (node as JsonLdRecipe)["@type"];
  if (typeof type === "string") return type.toLowerCase() === "recipe";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase() === "recipe");
  return false;
}

/** Walks a parsed JSON-LD payload (which may be a single object, an array, or contain
 * @graph) looking for the first node with @type "Recipe". */
function findRecipeNode(parsed: unknown): JsonLdRecipe | null {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (parsed && typeof parsed === "object") {
    if (isRecipeType(parsed)) return parsed as JsonLdRecipe;
    const graph = (parsed as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) return findRecipeNode(graph);
  }
  return null;
}

export interface JsonLdImportResult {
  recipe: DraftedRecipe;
  /** Present only when the JSON-LD node itself links out (e.g. a Pinterest pin's target blog) — unused by tryJsonLdRecipe itself. */
}

/** Tier 1. Fetches the URL, scans for schema.org Recipe JSON-LD, maps straight to a
 * DraftedRecipe shape — no AI call. Returns null (not throw) on any failure so the
 * caller falls through to Tier 2/3. */
export async function tryJsonLdRecipe(url: string): Promise<DraftedRecipe | null> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();

    const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRe.exec(html)) !== null) {
      const raw = match[1]!.trim();
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const node = findRecipeNode(parsed);
      if (!node) continue;

      const ingredientLines = Array.isArray(node.recipeIngredient)
        ? (node.recipeIngredient as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (ingredientLines.length === 0) continue;

      const ingredients = ingredientLines.map(parseIngredientLine);
      const steps = instructionsToSteps(node.recipeInstructions);
      if (!node.name || steps.length === 0) continue;

      return {
        title: node.name,
        description: typeof node.description === "string" ? node.description : "",
        ingredients,
        steps,
        tags: [],
        servings: parseYield(node.recipeYield),
        prepTimeMinutes: parseIsoDurationMinutes(node.prepTime),
        cookTimeMinutes: parseIsoDurationMinutes(node.cookTime),
      };
    }
    return null;
  } catch (err) {
    console.error("[uiu-api] tryJsonLdRecipe failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — platform oEmbed/API caption/description text
// ---------------------------------------------------------------------------

/** Tier 2. Fetches a caption/description string via the platform's public API.
 * Returns null (not throw) on any failure or when the platform has no such API
 * (Instagram/Facebook) so the caller falls through to Tier 3. */
export async function tryOembedCaption(url: string, platform: string, env: OembedEnv): Promise<{ text: string } | null> {
  try {
    if (platform === "tiktok") {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { headers: FETCH_HEADERS });
      if (!res.ok) return null;
      const json = (await res.json()) as { title?: string };
      return json.title ? { text: json.title } : null;
    }
    if (platform === "pinterest") {
      const res = await fetch(`https://api.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`, { headers: FETCH_HEADERS });
      if (!res.ok) return null;
      const json = (await res.json()) as { title?: string };
      return json.title ? { text: json.title } : null;
    }
    if (platform === "youtube") {
      if (!env.YOUTUBE_API_KEY) return null;
      const videoId = extractYoutubeId(url);
      if (!videoId) return null;
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet&key=${env.YOUTUBE_API_KEY}`;
      const res = await fetch(apiUrl);
      if (!res.ok) return null;
      const json = (await res.json()) as { items?: Array<{ snippet?: { description?: string } }> };
      const description = json.items?.[0]?.snippet?.description;
      return description ? { text: description } : null;
    }
    // Instagram / Facebook: no usable public oEmbed for caption text — Tier 3 only.
    return null;
  } catch (err) {
    console.error("[uiu-api] tryOembedCaption failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function extractYoutubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "") || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

/** Pinterest pins usually link out to the original blog post — if present, prefer
 * re-running Tier 1 against that link (HANDOFF §0). Best-effort, never throws. */
export async function tryPinterestTargetLink(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const json = (await res.json()) as { provider_url?: string; url?: string };
    // Pinterest's oEmbed doesn't reliably expose the outbound link field name — try the
    // common candidates; if none present, caller just skips this step.
    return (json as Record<string, unknown>).original_url as string | undefined
      ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2/3 shared — free-text -> structured recipe via OpenRouter
// ---------------------------------------------------------------------------

const MIN_INGREDIENTS = 2;

/** Reuses the same OPENROUTER_API_KEY/model as the daily draft agent (draftRecipe()) —
 * different prompt shape (parse existing text, not invent a new dish). Returns null
 * (not throw) when the call fails or the parsed result looks too thin to be a real
 * recipe (HANDOFF §0: "材料/步驟太短/太空" -> treat as failure, fall to Tier 3). */
export async function parseRecipeFromText(env: OpenRouterEnv, text: string): Promise<DraftedRecipe | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const prompt =
      `The following text is a caption or pasted description for a recipe, possibly with a lot of ` +
      `unrelated commentary/hashtags mixed in. Extract the actual recipe from it — do not invent ` +
      `ingredients or steps that are not implied by the text.\n\n` +
      `Text:\n"""\n${trimmed}\n"""\n\n` +
      `Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape: ` +
      `{"title": string, "description": string, "ingredients": [{"name": string, "quantity": number, "unit": string}], ` +
      `"steps": [string], "tags": [string], "mealType": string, "servings": number, "prepTimeMinutes": number, "cookTimeMinutes": number}.`;

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    const fenced = content.trim().match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced ? fenced[1]! : content.trim();
    const parsed = JSON.parse(candidate) as Partial<DraftedRecipe>;

    if (!parsed.title || !Array.isArray(parsed.ingredients) || parsed.ingredients.length < MIN_INGREDIENTS || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
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
    console.error("[uiu-api] parseRecipeFromText failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
