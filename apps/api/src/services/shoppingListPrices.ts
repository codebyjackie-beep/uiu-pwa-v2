/**
 * cc_prompt_shopping_list_price_compare.md Part B — every qualified supermarket product for a shopping-list line, read from
 * canonical_price_cache (0 Serper credits; nothing is fetched or written here). Pure logic: no mongodb / fetch.
 *
 * Qualified listing = a whitelisted UK supermarket (UK_SUPERMARKETS, marketplaces excluded), a real price, not a duplicate
 * (same store + title + price), and — when its £/unit is known — within the same ±3x-of-median band the refresh guard uses
 * (isOutlier3x, imported, not copied). A listing whose pack is unknown keeps perUnit null (never guessed) and sorts last.
 */
import type { Document } from "mongodb";
import type { ShoppingListItemPrices, ShoppingListPriceOption } from "@uiu/shared";
import { isStockLikeName } from "@uiu/shared";
import { isOutlier3x, isUkSupermarket, median } from "./priceRefreshGuard";

/** Ordered: first hit wins. Display names are what the Shop tab shows. */
const STORES: { key: string; name: string; match: RegExp }[] = [
  { key: "tesco", name: "Tesco", match: /tesco/ },
  { key: "sainsburys", name: "Sainsbury's", match: /sainsbury/ },
  { key: "asda", name: "Asda", match: /asda/ },
  { key: "morrisons", name: "Morrisons", match: /morrisons/ },
  { key: "waitrose", name: "Waitrose", match: /waitrose/ },
  { key: "ocado", name: "Ocado", match: /ocado/ },
  { key: "iceland", name: "Iceland", match: /iceland/ },
  { key: "coop", name: "Co-op", match: /co-?op\b|co op\b/ },
  { key: "aldi", name: "Aldi", match: /aldi/ },
  { key: "lidl", name: "Lidl", match: /lidl/ },
];

/** "sainsburys.co.uk" / "Asda Groceries" / "Morrisons.com" / "Waitrose & Partners" -> store, or null when not a whitelisted supermarket. */
export function normaliseStore(raw: unknown): { key: string; name: string } | null {
  if (typeof raw !== "string" || !isUkSupermarket(raw)) return null;
  const s = raw.toLowerCase();
  const hit = STORES.find((st) => st.match.test(s));
  return hit ? { key: hit.key, name: hit.name } : null;
}

const LIQUID_TITLE_UNIT_RE = /\d\s?(ml|cl|l|litre|liter|litres|liters)\b/i;
const LIQUID_NAME_RE = /\b(milk|oil|wine|beer|stock|broth|juice|vinegar|cream|water|sauce|cider|spirit|brandy|rum|vodka|whisky|whiskey|sherry|syrup|passata)\b/i;

const SOLID_TITLE_UNIT_RE = /\d\s?(kg|g)\b/i;

/** Cache packs are "g_or_ml" — kg or L is decided from the title's own unit first, then from what the product is. */
function isLiquid(title: string, canonicalName: string): boolean {
  if (LIQUID_TITLE_UNIT_RE.test(title)) return true;
  if (SOLID_TITLE_UNIT_RE.test(title)) return false;
  return LIQUID_NAME_RE.test(canonicalName) || /\b(milk|oil|juice|vinegar|stock|broth)\b/i.test(title);
}

const trim2 = (v: number): string => String(Math.round(v * 100) / 100);

function packLabel(qty: number, unit: "g_or_ml" | "each", liquid: boolean): string {
  if (unit === "each") return qty === 1 ? "each" : `${trim2(qty)} pack`;
  if (liquid) return qty >= 1000 ? `${trim2(qty / 1000)}L` : `${trim2(qty)}ml`;
  return qty >= 1000 ? `${trim2(qty / 1000)}kg` : `${trim2(qty)}g`;
}

type RawCacheListing = {
  store?: unknown;
  title?: unknown;
  price?: unknown;
  pack?: { qty?: unknown; unit?: unknown } | null;
  source_of_pack?: unknown;
  per_unit?: unknown;
};

export interface DroppedOutlier {
  canonical: string;
  store: string;
  title: string;
  price: number;
  perUnit: number;
  median: number;
}

export interface PriceOptionsResult {
  options: ShoppingListPriceOption[];
  droppedOutliers: DroppedOutlier[];
  /** listings with a non-whitelisted store / no price / duplicate */
  droppedOther: number;
}

const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Qualified options for one canonical_price_cache doc, sorted £/unit asc (null £/unit last, by price). */
export function buildPriceOptions(canonicalName: string, listings: unknown): PriceOptionsResult {
  const stock = isStockLikeName(canonicalName);
  const seen = new Set<string>();
  let droppedOther = 0;
  type Cand = ShoppingListPriceOption & { _dim: "metric" | "each" | null; _rawPerUnit: number | null };
  const cands: Cand[] = [];

  for (const l of Array.isArray(listings) ? (listings as RawCacheListing[]) : []) {
    const st = normaliseStore(l?.store);
    const price = typeof l?.price === "number" ? l.price : Number.NaN;
    if (!st || !isPos(price)) { droppedOther++; continue; }
    const title = typeof l.title === "string" ? l.title : "";
    const dedupKey = `${st.key}|${title.trim().toLowerCase()}|${price}`;
    if (seen.has(dedupKey)) { droppedOther++; continue; }
    seen.add(dedupKey);

    const qty = l.pack && isPos(l.pack.qty) ? l.pack.qty : null;
    const unit = l.pack && (l.pack.unit === "g_or_ml" || l.pack.unit === "each") ? l.pack.unit : null;
    const known = qty !== null && unit !== null;
    const liquid = isLiquid(title, canonicalName);
    let perUnit: ShoppingListPriceOption["perUnit"] = null;
    let dim: Cand["_dim"] = null;
    let raw: number | null = null;
    if (known && unit === "g_or_ml") {
      raw = price / qty;
      perUnit = { value: Math.round(raw * 1000 * 100) / 100, unit: liquid ? "L" : "kg" };
      dim = "metric";
    } else if (known && unit === "each") {
      raw = price / qty;
      perUnit = { value: Math.round(raw * 100) / 100, unit: "each" };
      dim = "each";
    }
    cands.push({
      store: st.name,
      storeKey: st.key,
      title,
      price: Math.round(price * 100) / 100,
      packLabel: known ? packLabel(qty, unit, liquid) : null,
      perUnit,
      ...(known && l.source_of_pack === "reference" ? { packAssumed: true as const } : {}),
      ...(stock ? { stockLabel: true as const } : {}),
      _dim: dim,
      _rawPerUnit: raw,
    });
  }

  // ±3x of the median, per dimension (kg/L together, each on its own) — the refresh guard's Guard 5 band.
  const droppedOutliers: DroppedOutlier[] = [];
  const out: Cand[] = [];
  for (const dim of ["metric", "each"] as const) {
    const group = cands.filter((c) => c._dim === dim);
    const med = median(group.map((c) => c._rawPerUnit as number));
    for (const c of group) {
      if (med !== null && isOutlier3x(c._rawPerUnit as number, med)) {
        droppedOutliers.push({ canonical: canonicalName, store: c.store, title: c.title, price: c.price, perUnit: c.perUnit!.value, median: Math.round(med * (dim === "metric" ? 1000 : 1) * 100) / 100 });
      } else out.push(c);
    }
  }
  out.push(...cands.filter((c) => c._dim === null));

  // Sort: £/unit asc inside the dominant unit (kg vs L vs each can't be compared); other units after; unknown pack last by price.
  const counts = new Map<string, number>();
  for (const c of out) if (c.perUnit) counts.set(c.perUnit.unit, (counts.get(c.perUnit.unit) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const rank = (c: Cand): number => (!c.perUnit ? 2 : c.perUnit.unit === dominant ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || (a.perUnit && b.perUnit ? a.perUnit.value - b.perUnit.value : 0) || a.price - b.price);

  return { options: out.map(({ _dim, _rawPerUnit, ...o }) => o), droppedOutliers, droppedOther };
}

/** Wire shape for one shopping-list line, or null when the doc has no qualified listing at all. */
export function buildItemPrices(canonicalName: string, doc: Document): ShoppingListItemPrices | null {
  const { options } = buildPriceOptions(canonicalName, doc.listings);
  if (!options.length) return null;
  const cheapestPack = options.reduce((m, o) => (o.price < m.price ? o : m));
  const dominantUnit = options.find((o) => o.perUnit)?.perUnit?.unit;
  const bestValue = options.find((o) => o.perUnit && o.perUnit.unit === dominantUnit) ?? null;
  const fetched = (doc.metadata as { fetched_at?: unknown } | null | undefined)?.fetched_at;
  const stamp = typeof fetched === "string" ? fetched : fetched instanceof Date ? fetched.toISOString() : null;
  return { options, cheapestPack, bestValue, stamp };
}
