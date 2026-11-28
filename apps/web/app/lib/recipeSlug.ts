/**
 * SEO PR3 — recipe slug URLs: /recipes/<slug>-<24 hex id>.
 *
 * The id is always the trailing 24 hex chars; the slug is decoration made from the title at render
 * time (no DB field). Parsing never trusts the slug, so a stale / edited title still resolves and the
 * detail page 308-redirects it to the canonical spelling.
 *
 * FROZEN: changing recipeSlug's output changes every canonical URL and redirects all indexed slugs
 * once more. Only change it on purpose, and keep parseRecipeParam accepting the old shapes.
 */

/** Max slug length before the "-<id>" suffix. Cut on a word boundary. */
export const RECIPE_SLUG_MAX = 60;
export const RECIPE_SLUG_FALLBACK = "recipe";

const OBJECT_ID = /^[0-9a-f]{24}$/;
/** Bare id, or "<anything>-<id>". Case-insensitive; callers get the id lowercased. */
const SEGMENT = /^(?:(.*)-)?([0-9a-fA-F]{24})$/;

/**
 * Title → URL slug: ASCII [a-z0-9-] only (no "." — the middleware matcher skips dotted paths), accents
 * folded (crème → creme), "&" → "and", runs of anything else → one "-", capped at RECIPE_SLUG_MAX on a
 * word boundary. Empty / emoji-only / non-Latin titles → "recipe".
 */
export function recipeSlug(title: unknown): string {
  if (typeof title !== "string") return RECIPE_SLUG_FALLBACK;
  const ascii = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .replace(/œ/gi, "oe")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’‘`]/g, "") // "shepherd's" → "shepherds", not "shepherd-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ascii) return RECIPE_SLUG_FALLBACK;
  if (ascii.length <= RECIPE_SLUG_MAX) return ascii;
  const cut = ascii.slice(0, RECIPE_SLUG_MAX + 1);
  const lastDash = cut.lastIndexOf("-");
  // Word boundary if there is one in a sensible place; otherwise hard cut (one very long word).
  const trimmed = (lastDash >= 20 ? cut.slice(0, lastDash) : ascii.slice(0, RECIPE_SLUG_MAX)).replace(/-+$/g, "");
  return trimmed || RECIPE_SLUG_FALLBACK;
}

/** "/recipes/<slug>-<id>". `id` must be a 24-hex ObjectId; anything else falls back to the encoded raw id. */
export function recipePath(id: string, title: unknown): string {
  const lower = typeof id === "string" ? id.toLowerCase() : "";
  if (!OBJECT_ID.test(lower)) return `/recipes/${encodeURIComponent(String(id ?? ""))}`;
  return `/recipes/${recipeSlug(title)}-${lower}`;
}

/** The URL segment only ("<slug>-<id>"), for comparing with the incoming [id] param. */
export function recipeSegment(id: string, title: unknown): string {
  return recipePath(id, title).slice("/recipes/".length);
}

/**
 * [id] route param → recipe id (lowercase 24 hex), or null when the segment carries no valid id.
 * Accepts the old bare "/recipes/<id>" and any "<slug>-<id>" (slug ignored). Percent-encoded input is
 * decoded first (Next passes params decoded, but be safe).
 */
export function parseRecipeParam(segment: unknown): string | null {
  if (typeof segment !== "string" || !segment) return null;
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // malformed % sequence — use as-is
  }
  const m = SEGMENT.exec(s.trim());
  return m ? m[2].toLowerCase() : null;
}

/**
 * Rebuild a query string from Next's searchParams object (multi-value keys kept, order kept).
 * Returns "" or "?a=1&b=2".
 */
export function queryStringFrom(searchParams: Record<string, string | string[] | undefined> | null | undefined): string {
  if (!searchParams) return "";
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }
  const out = qs.toString();
  return out ? `?${out}` : "";
}
