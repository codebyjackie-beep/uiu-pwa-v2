/**
 * Shared pure helpers for SEO hub pages (lists of public recipes grouped by ingredient / price).
 *
 * Price rule (Jackie 2026-11-26): a £ figure is only ever shown for cost tier "full" (>= 80% of
 * ingredient lines priced). Partial / unavailable recipes can still be listed, but never feed a
 * price range, a title or a meta description.
 *
 * No Next / React / Clerk imports and no @uiu/shared *runtime* import (its package exports are ESM-only,
 * which tsx can't require), so the standalone tests run under plain Node via tsx. The tier decision is
 * made once in hubPricing.ts (toHubRecipe) with the shared costDisplayTier and passed in as `fullTierPrice`.
 */

import { recipePath } from "./recipeSlug";

export const HUB_SITE_BASE = "https://useitup.uk";

/** The list-item fields a hub needs. Build with toHubRecipe (hubPricing.ts). */
export interface HubRecipe {
  _id: string;
  title: string;
  tags: string[];
  /** Per-serving £ only when the cost tier is "full" (>= 80% coverage, > £0); otherwise null. */
  fullTierPrice: number | null;
  updatedAt?: string;
}

export interface HubLink {
  href: string;
  label: string;
}

export interface HubNavGroup {
  title: string;
  links: HubLink[];
}

/** Per-serving £ for a tier-"full" recipe, else null (partial / unavailable / missing / 0 / junk). */
export function fullTierPerServing(r: Pick<HubRecipe, "fullTierPrice">): number | null {
  const v = r.fullTierPrice;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** "£0.93" — same 2dp rounding as formatCostWithCoverage, so hubs and recipe pages show the same figure. */
export function formatGbp(value: number): string {
  return `£${value.toFixed(2)}`;
}

/** Min / max per-serving £ across the tier-"full" recipes only; null when none of them is fully priced. */
export function fullTierPriceRange(recipes: Pick<HubRecipe, "fullTierPrice">[]): { min: number; max: number; count: number } | null {
  const prices = recipes.map(fullTierPerServing).filter((p): p is number => p != null);
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices), count: prices.length };
}

/** Fully-priced recipes first, cheapest first; then the rest by title. Stable and deterministic. */
export function sortForHub<T extends HubRecipe>(recipes: T[]): T[] {
  return [...recipes].sort((a, b) => {
    const pa = fullTierPerServing(a);
    const pb = fullTierPerServing(b);
    if (pa != null && pb != null && pa !== pb) return pa - pb;
    if (pa != null && pb == null) return -1;
    if (pa == null && pb != null) return 1;
    return a.title.localeCompare(b.title) || a._id.localeCompare(b._id);
  });
}

/** Newest real `updatedAt` among the members (sitemap lastmod); never invents a date. */
export function latestUpdatedAt(recipes: { updatedAt?: unknown }[]): Date | undefined {
  let best = -Infinity;
  for (const r of recipes) {
    const raw = r.updatedAt;
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return Number.isFinite(best) ? new Date(best) : undefined;
}

/**
 * schema.org ItemList (summary-page pattern): ListItem with position + url only, each url a recipe
 * detail page that carries its own Recipe JSON-LD. Serialise with serializeJsonLd (recipeJsonLd.ts).
 */
export function buildItemListJsonLd(input: { name: string; path: string; recipes: Pick<HubRecipe, "_id" | "title">[] }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: input.name,
    url: `${HUB_SITE_BASE}${input.path}`,
    numberOfItems: input.recipes.length,
    itemListElement: input.recipes.map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${HUB_SITE_BASE}${recipePath(r._id, r.title)}`,
    })),
  };
}
