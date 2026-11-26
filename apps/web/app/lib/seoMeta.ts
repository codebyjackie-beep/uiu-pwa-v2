/**
 * SEO helpers for page <title> / meta description (seo_meta_copy 2026-11-26).
 * Pure functions only — no @uiu/shared runtime import, so the standalone test runs with plain tsx.
 */

export const TITLE_SUFFIX = " · UseItUp";
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
export const RECIPE_DESCRIPTION_FALLBACK = "A UseItUp recipe with its cost per serving at UK supermarkets.";

/** Cut `s` to at most `n` chars, at a word boundary, ending in "…". */
export function clamp(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  if (n <= 1) return "…".slice(0, n);
  const cut = t.slice(0, n - 1);
  // If the next char is whitespace, `cut` already ends on a whole word; otherwise drop the partial word.
  const atWord = /\s/.test(t.charAt(n - 1)) ? cut : cut.replace(/\s+\S*$/, "");
  return (atWord || cut).replace(/[\s,;:.–—-]+$/, "") + "…";
}

/** "<name> · UseItUp", ≤60 chars; the name is shortened, the brand suffix is always kept. */
export function recipeMetaTitle(name: string): string {
  const base = name.trim() || "Recipe";
  return clamp(base, TITLE_MAX - TITLE_SUFFIX.length) + TITLE_SUFFIX;
}

/** Already-formatted cost (from formatCostWithCoverage) — passed in so this file stays dependency-free. */
export interface MetaCost {
  tier: "full" | "partial" | "unavailable";
  text: string;
}

export interface RecipeMetaInput {
  description?: string | null;
  servings?: number | null;
  prepTimeMinutes?: number | null;
  cookTimeMinutes?: number | null;
  cost?: MetaCost | null;
}

/**
 * First sentence of the recipe description + "Serves N, ready in M min, about £x per serving at UK supermarkets."
 * The £ figure only appears for tier "full" (Jackie 2026-11-26); partial ("£x+") / unavailable never show a price.
 * The facts sentence is kept whole — only the lead sentence is shortened to fit ≤155 chars.
 */
export function recipeMetaDescription(r: RecipeMetaInput): string {
  const total = (r.prepTimeMinutes ?? 0) + (r.cookTimeMinutes ?? 0);
  const parts = [
    r.servings && r.servings > 0 ? `Serves ${r.servings}` : null,
    total > 0 ? `ready in ${total} min` : null,
    r.cost?.tier === "full" ? `about ${r.cost.text} per serving at UK supermarkets` : null,
  ].filter((p): p is string => !!p);
  const facts = parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + "." : "";

  const lead = (r.description ?? "").trim().replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0] ?? "";
  const room = DESCRIPTION_MAX - (facts ? facts.length + 1 : 0);
  const leadFit = lead && room >= 20 ? clamp(lead, room) : "";

  const out = [leadFit, facts].filter(Boolean).join(" ");
  return out ? clamp(out, DESCRIPTION_MAX) : RECIPE_DESCRIPTION_FALLBACK;
}
