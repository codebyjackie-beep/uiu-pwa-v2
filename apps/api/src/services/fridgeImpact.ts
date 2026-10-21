/**
 * Impact / use-it-up (claude/research_rminder_competitors.md #1 + #2, Jackie 2026-10-21 "就做1，2").
 * When a fridge item leaves the fridge the user says whether it was used or thrown away; that event is logged to
 * `fridge_events` with an estimated £ value from canonical_price_cache (read only, 0 Serper credits).
 * The value is an estimate: null when the item has no exact canonical, no price for its unit, or an unknown unit —
 * those still count as items, never as £.
 */
import type { Db, Document } from "mongodb";
import type { CanonicalIngredient, CanonicalPriceCacheEntry } from "@uiu/shared";
import { buildAliasIndex, resolve } from "./ingredientResolver";
import { normalizeQty } from "./recipeCost";

export type FridgeOutcome = "used" | "wasted";
export const FRIDGE_EVENTS = "fridge_events";

const METRIC_UNITS: Record<string, number> = { g: 1, gram: 1, grams: 1, kg: 1000, ml: 1, l: 1000, litre: 1000, liter: 1000 };
const COUNT_UNITS = new Set(["pc", "pcs", "piece", "pieces", "each", "unit", "units", "count", "x", ""]);

/** £ estimate for `quantity unit` of a canonical, or null when it can't be priced honestly. */
export function estimateValueGbp(priceDoc: Document | null, quantity: number, unit: string): number | null {
  if (!priceDoc || !(quantity > 0)) return null;
  const u = unit.trim().toLowerCase();
  if (u in METRIC_UNITS) {
    const per = priceDoc.per_unit_metric?.value;
    return typeof per === "number" && per > 0 ? +(per * quantity * METRIC_UNITS[u]!).toFixed(2) : null;
  }
  if (COUNT_UNITS.has(u)) {
    const per = priceDoc.per_unit_count?.value;
    return typeof per === "number" && per > 0 ? +(per * quantity).toFixed(2) : null;
  }
  return null;
}

/**
 * £ estimate using the same unit rules as recipe costing (recipeCost.normalizeQty): count items
 * ("1 pc broccoli") convert to grams through the canonical's per_item_g when only a £/kg price
 * exists, volumes through density. Falls back to the simple metric/count estimate above.
 */
export function estimateValueWithCanonical(canonicalDoc: Document | null, priceDoc: Document | null, quantity: number, unit: string): number | null {
  if (!priceDoc || !(quantity > 0)) return null;
  if (canonicalDoc) {
    const norm = normalizeQty(quantity, unit, canonicalDoc as unknown as CanonicalIngredient, priceDoc as unknown as CanonicalPriceCacheEntry);
    if (!("unpriceable" in norm)) {
      const per = norm.bucket === "count" ? priceDoc.per_unit_count?.value : priceDoc.per_unit_metric?.value;
      if (typeof per === "number" && per > 0) return +(per * norm.normValue).toFixed(2);
    }
  }
  return estimateValueGbp(priceDoc, quantity, unit);
}

async function valueForCanonical(db: Db, canonicalName: string | null, quantity: number, unit: string): Promise<number | null> {
  if (!canonicalName) return null;
  const [canonicalDoc, priceDoc] = await Promise.all([
    db.collection("canonical_ingredients").findOne({ canonical_name: canonicalName }),
    db.collection("canonical_price_cache").findOne({ canonical_name: canonicalName }, { projection: { per_unit_metric: 1, per_unit_count: 1 } }),
  ]);
  return estimateValueWithCanonical(canonicalDoc, priceDoc, quantity, unit);
}

/** Grams for metric units (ml counted as g), else null — used for the "kg kept out of the bin" line. */
export function estimateGrams(quantity: number, unit: string): number | null {
  const u = unit.trim().toLowerCase();
  return u in METRIC_UNITS && quantity > 0 ? quantity * METRIC_UNITS[u]! : null;
}

async function canonicalNameFor(db: Db, item: Document): Promise<string | null> {
  if (item.canonicalIngredientId) {
    const c = await db.collection("canonical_ingredients").findOne({ _id: item.canonicalIngredientId }, { projection: { canonical_name: 1 } });
    if (c?.canonical_name) return String(c.canonical_name);
  }
  const r = resolve(String(item.ingredientName ?? ""), await buildAliasIndex(db.collection("canonical_ingredients")));
  return "canonical_name" in r && r.method === "exact" ? r.canonical_name : null;
}

/** Logs a used / wasted event for a fridge item that is about to be removed. */
export async function logFridgeEvent(db: Db, userId: string, item: Document, outcome: FridgeOutcome, at = new Date()) {
  const canonicalName = await canonicalNameFor(db, item);
  const quantity = Number(item.quantity) || 0;
  const unit = String(item.unit ?? "");
  const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
  const doc = {
    userId,
    outcome,
    ingredientName: String(item.ingredientName ?? ""),
    canonicalName,
    quantity,
    unit,
    valueGbp: await valueForCanonical(db, canonicalName, quantity, unit),
    grams: estimateGrams(quantity, unit),
    expiresAt,
    /** Used on or before its expiry day (the "used it up in time" count). */
    beforeExpiry: expiresAt ? at.getTime() <= expiresAt.getTime() + 864e5 : null,
    at,
  };
  await db.collection(FRIDGE_EVENTS).insertOne(doc);
  return doc;
}

export type ImpactBucket = { items: number; valueGbp: number; pricedItems: number; grams: number };
export type ImpactSummary = {
  month: { used: ImpactBucket; wasted: ImpactBucket; since: string };
  allTime: { used: ImpactBucket; wasted: ImpactBucket; since: string | null };
  /** Share of items that left the fridge as "used" rather than "wasted" (all time), or null with no events. */
  usedRate: number | null;
};

const empty = (): ImpactBucket => ({ items: 0, valueGbp: 0, pricedItems: 0, grams: 0 });

export async function impactSummary(db: Db, userId: string, now = new Date()): Promise<ImpactSummary> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const events = await db.collection(FRIDGE_EVENTS).find({ userId }, { projection: { outcome: 1, valueGbp: 1, grams: 1, at: 1, canonicalName: 1, quantity: 1, unit: 1 } }).sort({ at: 1 }).toArray();
  // Events logged before count items were priced through per_item_g have valueGbp null — fill them once.
  for (const e of events) {
    if (e.valueGbp == null && e.canonicalName) {
      const v = await valueForCanonical(db, String(e.canonicalName), Number(e.quantity) || 0, String(e.unit ?? ""));
      if (v != null) {
        e.valueGbp = v;
        await db.collection(FRIDGE_EVENTS).updateOne({ _id: e._id, valueGbp: null }, { $set: { valueGbp: v, valueFilledAt: now } });
      }
    }
  }
  const out: ImpactSummary = {
    month: { used: empty(), wasted: empty(), since: monthStart.toISOString() },
    allTime: { used: empty(), wasted: empty(), since: events[0]?.at ? new Date(events[0].at).toISOString() : null },
    usedRate: null,
  };
  for (const e of events) {
    const key = e.outcome === "wasted" ? "wasted" : "used";
    const add = (b: ImpactBucket) => {
      b.items += 1;
      if (typeof e.valueGbp === "number") {
        b.valueGbp = +(b.valueGbp + e.valueGbp).toFixed(2);
        b.pricedItems += 1;
      }
      if (typeof e.grams === "number") b.grams += e.grams;
    };
    add(out.allTime[key]);
    if (new Date(e.at).getTime() >= monthStart.getTime()) add(out.month[key]);
  }
  const total = out.allTime.used.items + out.allTime.wasted.items;
  out.usedRate = total ? +(out.allTime.used.items / total).toFixed(3) : null;
  return out;
}

/** Fridge items expiring within `days` (inclusive of already-expired today), soonest first. */
export async function expiringSoon(db: Db, userId: string, days: number, now = new Date()) {
  const end = new Date(now.getTime() + days * 864e5);
  return db
    .collection("fridge_stock")
    .find({ userId, needsRestock: { $ne: true }, expiresAt: { $lte: end.toISOString() } }, { projection: { ingredientName: 1, expiresAt: 1, quantity: 1, unit: 1 } })
    .sort({ expiresAt: 1 })
    .limit(20)
    .toArray();
}
