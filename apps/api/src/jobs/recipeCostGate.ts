/**
 * recipe_cost recompute with an anomaly gate (cc_prompt_price_refresh_monthly_cron.md Part 3).
 *
 * Shared by the weekly "0 3 * * MON" precompute and the monthly price-refresh job. Computes the cost of EVERY recipe, compares the
 * PUBLIC ones with the stored recipe_cost doc, and only writes when no public recipe trips the gate (same thresholds as
 * scripts/recipe_cost_recompute.cjs, which cloud reviewed on 2026-10-16):
 *   - perServing > £8          (a recipe that was already > £8 is exempt unless it rises > 50% — e.g. Crab Cakes Eggs Benedict,
 *                               accepted by cloud decision 29; otherwise the gate would trip every week forever)
 *   - perServing drops > 50%   (or becomes unavailable)
 *   - display tier changes     (full >= 80% adjusted coverage, partial >= 50%, else unavailable)
 * Any anomaly => NOTHING is written (recipe_cost stays as it was), the anomalies come back to the caller to Telegram.
 *
 * `priceOverlay` lets a dry-run price refresh project what recipe_cost WOULD be with its proposed price docs, without touching Mongo.
 */
import type { Db, Document, ObjectId as ObjectIdType } from "mongodb";
import type { CanonicalIngredient, CanonicalPriceCacheEntry, Recipe } from "@uiu/shared";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";

export const GATE_PER_SERVING_MAX = 8;
export const GATE_DROP_MAX = 0.5;
const FULL_PCT = 80;
const MIN_PCT = 50;
const PLAN_NAME_RE = /weekly plan 6/i;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const tierOf = (pct: number | null) => (pct == null || !Number.isFinite(pct) ? "unavailable" : pct >= FULL_PCT ? "full" : pct >= MIN_PCT ? "partial" : "unavailable");
// perServing as the app uses it: finite and > 0, else null
const psOf = (c: any): number | null => {
  const v = c ? num(c.perServing) : null;
  return v != null && v > 0 ? v : null;
};
const covOf = (c: any): number | null => (c ? num(c.adjustedCoveragePct) : null);

export interface GateAnomaly {
  id: string;
  title: string;
  rule: string;
  before: number | string | null;
  after: number | string | null;
}
export interface CostStats {
  tiers: { full: number; partial: number; unavailable: number };
  perServing: { under1_5: number; "1_5to3": number; "3plus": number; excluded: number };
  weeklyPlan6: Array<{ name: string; total: number; entriesWithoutPrice: number }>;
}
export interface GatedRecompute {
  write: boolean;
  /** true when recipe_cost docs were actually upserted */
  wrote: boolean;
  recipes: number;
  publicRecipes: number;
  publicChanged: number;
  anomalies: GateAnomaly[];
  before: CostStats;
  after: CostStats;
  // PrecomputeSummary fields (kept for /api/admin/recompute-costs)
  avgAdjustedCoveragePct: number;
  adjustedPriceableTotal: number;
  adjustedTotalSum: number;
  lineWeightedAdjustedPct: number;
  withBasket: number;
  priceCacheStamp: number;
}

function statsOf(
  publicIds: string[],
  costById: Map<string, any>,
  planSets: Document[],
  planEntries: Map<string, Document[]>,
): CostStats {
  const tiers = { full: 0, partial: 0, unavailable: 0 };
  const perServing = { under1_5: 0, "1_5to3": 0, "3plus": 0, excluded: 0 };
  for (const id of publicIds) {
    const c = costById.get(id);
    const t = tierOf(covOf(c)) as keyof typeof tiers;
    tiers[t] += 1;
    const ps = psOf(c);
    if (ps == null || t === "unavailable") { perServing.excluded += 1; continue; }
    if (ps < 1.5) perServing.under1_5 += 1;
    else if (ps < 3) perServing["1_5to3"] += 1;
    else perServing["3plus"] += 1;
  }
  const weeklyPlan6: CostStats["weeklyPlan6"] = [];
  for (const s of planSets) {
    if (!PLAN_NAME_RE.test(String(s.name ?? ""))) continue;
    const entries = planEntries.get(String(s._id)) ?? [];
    let total = 0;
    let missing = 0;
    for (const e of entries) {
      const ps = psOf(costById.get(String(e.recipeId)));
      if (ps == null) { missing += 1; continue; }
      total += ps * (num(e.servings) ?? 1);
    }
    weeklyPlan6.push({ name: String(s.name), total: r2(total), entriesWithoutPrice: missing });
  }
  return { tiers, perServing, weeklyPlan6 };
}

/**
 * @param write - true: upsert every recipe's recipe_cost doc IF the gate passes. false: compute + report only.
 * @param priceOverlay - canonical_name -> price doc to use instead of the stored one (dry-run projection).
 */
export async function recomputeRecipeCostsGated(
  db: Db,
  opts: { write: boolean; priceOverlay?: Map<string, Document> },
): Promise<GatedRecompute> {
  const ingredientsCol = db.collection<Document>("canonical_ingredients");
  const recipeCostCol = db.collection<Document>("recipe_cost");

  // Deliberately unfiltered (all docs, not just non-quarantine) — the alias index below filters quarantine for matching, but
  // ingredientsMap needs every doc so a resolved canonical_name always has a doc to join to.
  const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
  const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));

  const allPriceDocs = (await db.collection<Document>("canonical_price_cache").find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
  const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));
  if (opts.priceOverlay) for (const [k, v] of opts.priceOverlay) priceMap.set(k, v as unknown as CanonicalPriceCacheEntry);

  const index = await buildAliasIndex(ingredientsCol);
  const resolveFn = (rawName: string) => resolve(rawName, index);
  const quarantinedNames = new Set(
    allIngredientDocs.filter((d) => d.quarantine === true).map((d) => d.canonical_name.toLowerCase().trim()),
  );

  // NOTE (2026-07-25): canonical_price_cache docs have no top-level `updatedAt`; the real timestamp is nested `metadata.fetched_at`.
  const priceCacheStamp = [...priceMap.values()].reduce((max, d) => {
    const fetchedAt = d.metadata?.fetched_at;
    const t = fetchedAt ? new Date(fetchedAt).getTime() : 0;
    return t > max ? t : max;
  }, 0);

  const allRecipes = (await db.collection<Document>("recipes").find({}).toArray()) as unknown as Array<Recipe & { _id: ObjectIdType; isPublic?: boolean }>;
  const storedById = new Map((await recipeCostCol.find({}).toArray()).map((d) => [String(d.recipeId), d]));

  const computedAt = new Date().toISOString();
  const fresh: Array<{ recipe: (typeof allRecipes)[number]; cost: ReturnType<typeof costRecipe> }> = [];
  const freshById = new Map<string, any>();
  let coverageSum = 0;
  let withAdjustedDenom = 0;
  let withBasket = 0;
  let adjustedPriceableTotal = 0;
  let adjustedTotalSum = 0;
  for (const recipe of allRecipes) {
    const cost = costRecipe(recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);
    fresh.push({ recipe, cost });
    freshById.set(String(recipe._id), cost);
    adjustedPriceableTotal += cost.adjustedPriceable;
    adjustedTotalSum += cost.adjustedTotal;
    if (cost.adjustedTotal > 0) { coverageSum += cost.adjustedCoveragePct; withAdjustedDenom += 1; }
    if (cost.basket > 0) withBasket += 1;
  }

  // ---- gate (public recipes only) ----
  const publicIds = allRecipes.filter((r) => r.isPublic === true).map((r) => String(r._id));
  const titleById = new Map(allRecipes.map((r) => [String(r._id), String((r as any).title ?? "")]));
  const anomalies: GateAnomaly[] = [];
  let publicChanged = 0;
  for (const id of publicIds) {
    const st = storedById.get(id) ?? null;
    const fr = freshById.get(id);
    const psB = psOf(st);
    const psA = psOf(fr);
    const title = titleById.get(id) ?? id;
    if (st && (psB !== psA || tierOf(covOf(st)) !== tierOf(covOf(fr)))) publicChanged += 1;
    if (psA != null && psA > GATE_PER_SERVING_MAX && !(psB != null && psB > GATE_PER_SERVING_MAX && psA <= psB * 1.5)) {
      anomalies.push({ id, title, rule: `perServing > £${GATE_PER_SERVING_MAX}`, before: psB != null ? r4(psB) : null, after: r4(psA) });
    }
    if (psA != null && psB != null && psA < psB * (1 - GATE_DROP_MAX)) {
      anomalies.push({ id, title, rule: `perServing dropped > ${GATE_DROP_MAX * 100}%`, before: r4(psB), after: r4(psA) });
    }
    if (psA == null && psB != null) anomalies.push({ id, title, rule: "perServing became unavailable", before: r4(psB), after: null });
    if (st) {
      const tB = tierOf(covOf(st));
      const tA = tierOf(covOf(fr));
      if (tB !== tA) anomalies.push({ id, title, rule: "tier change", before: tB, after: tA });
    }
  }

  // ---- stats before/after (public recipes + Weekly Plan 6) ----
  const planSets = await db.collection<Document>("meal_plan_sets").find({}).toArray();
  const planEntries = new Map<string, Document[]>();
  for (const s of planSets) {
    if (!PLAN_NAME_RE.test(String(s.name ?? ""))) continue;
    planEntries.set(String(s._id), await db.collection<Document>("meal_plans").find({ planId: s._id }).toArray());
  }
  const before = statsOf(publicIds, storedById, planSets, planEntries);
  // "after" = what recipe_cost holds once this run finishes: fresh values if written, else projection of fresh values
  const after = statsOf(publicIds, freshById, planSets, planEntries);

  let wrote = false;
  if (opts.write && anomalies.length === 0) {
    await recipeCostCol.createIndex({ recipeId: 1 }, { unique: true });
    const ops = fresh.map(({ recipe, cost }) => ({
      updateOne: {
        filter: { recipeId: recipe._id },
        update: { $set: { recipeId: recipe._id, ...cost, computedAt, priceCacheStamp } },
        upsert: true,
      },
    }));
    // ordered:false + chunks keeps a single bad doc from stopping the rest and the payload small
    for (let i = 0; i < ops.length; i += 200) await recipeCostCol.bulkWrite(ops.slice(i, i + 200), { ordered: false });
    wrote = true;
  }

  return {
    write: opts.write,
    wrote,
    recipes: allRecipes.length,
    publicRecipes: publicIds.length,
    publicChanged,
    anomalies,
    before,
    after,
    avgAdjustedCoveragePct: withAdjustedDenom ? coverageSum / withAdjustedDenom : 0,
    adjustedPriceableTotal,
    adjustedTotalSum,
    lineWeightedAdjustedPct: adjustedTotalSum ? (adjustedPriceableTotal / adjustedTotalSum) * 100 : 0,
    withBasket,
    priceCacheStamp,
  };
}

/** Telegram (legacy Markdown) text for a tripped gate. Titles are escaped; at most 10 anomalies are listed. */
export function anomalyAlertText(headline: string, anomalies: GateAnomaly[]): string {
  const esc = (v: unknown) => String(v ?? "").replace(/([_*`[\]])/g, "\\$1");
  const lines = anomalies.slice(0, 10).map((a) => `  • ${esc(a.title)}: ${esc(a.rule)} (${a.before} → ${a.after})`);
  const more = anomalies.length > 10 ? `\n  … +${anomalies.length - 10} more` : "";
  return `🚨 *${esc(headline)}* — ${anomalies.length} anomaly(ies) tripped the gate; recipe\\_cost left as it was.\n${lines.join("\n")}${more}`;
}
