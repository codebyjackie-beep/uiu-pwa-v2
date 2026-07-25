/**
 * Precomputes and persists per-recipe cost into `recipe_cost` (upsert-only,
 * keyed by recipeId — never touches recipes/canonical_ingredients/canonical_price_cache).
 *
 * Ported from the old repo's precompute_recipe_costs.js (Mongoose, long-running
 * script), redesigned for Workers: no persistent process, so this runs as a
 * Cloudflare Cron Trigger `scheduled()` handler (see ../index.ts) using the
 * per-request withDb() pattern instead of a cached Mongoose connection.
 *
 * Should run as the LAST stage of the weekly Serper price-refresh chain (once
 * that's also migrated to Workers), after canonical_price_cache is updated,
 * so cost reflects current prices.
 *
 * Alias index build (buildAliasIndex) + full 741-doc/635-doc table scan is too
 * expensive to run per-request — this is deliberately a batch job that writes
 * a precomputed cache, not something the read path (routes/recipes.ts) invokes
 * on the fly.
 */
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { CanonicalIngredient, CanonicalPriceCacheEntry, Recipe } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { costRecipe } from "../services/recipeCost";

export interface PrecomputeSummary {
  dryRun: boolean;
  processed: number;
  /**
   * Mean of per-recipe adjustedCoveragePct, averaged only over recipes with
   * adjustedTotal > 0 (≈70.19% on the NEW 197-recipe dataset). This is NOT
   * the canonical coverage definition — do NOT use this field to verify
   * against the 71.36% parity baseline. Use `lineWeightedAdjustedPct` for
   * any coverage comparison.
   */
  avgAdjustedCoveragePct: number;
  /** Σ cost.adjustedPriceable across all recipes (numerator of the canonical metric). */
  adjustedPriceableTotal: number;
  /** Σ cost.adjustedTotal across all recipes (denominator of the canonical metric). */
  adjustedTotalSum: number;
  /**
   * Canonical line-weighted adjusted coverage = adjustedPriceableTotal /
   * adjustedTotalSum * 100. This is the ONLY field that should be compared
   * against the parity baseline (1278/1791 = 71.36% on the NEW 197-recipe
   * dataset). A real production dry-run must show 71.36% here before the
   * cron trigger gets re-enabled.
   */
  lineWeightedAdjustedPct: number;
  withBasket: number;
  priceCacheStamp: number;
}

/**
 * @param dryRun - when true, computes and returns the summary but never writes
 *   to `recipe_cost` (no createIndex, no updateOne). Use for verifying against
 *   production data before the first real populate.
 */
export async function precomputeRecipeCosts(env: DbEnv, dryRun = false): Promise<PrecomputeSummary> {
  return withDb(env, async (db) => {
    const ingredientsCol = db.collection<Document>("canonical_ingredients");
    const priceCol = db.collection<Document>("canonical_price_cache");
    const recipesCol = db.collection<Document>("recipes");
    const recipeCostCol = db.collection<Document>("recipe_cost");

    if (!dryRun) {
      await recipeCostCol.createIndex({ recipeId: 1 }, { unique: true });
    }

    // Deliberately unfiltered (all 741, not just non-quarantine) — the alias
    // index below filters quarantine for matching, but ingredientsMap needs
    // every doc so a resolved canonical_name (incl. non-quarantine docs that
    // happen to match a quarantined one's alias) always has a doc to join to.
    const allIngredientDocs = (await ingredientsCol.find({}).toArray()) as unknown as CanonicalIngredient[];
    const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));

    const allPriceDocs = (await priceCol.find({}).toArray()) as unknown as CanonicalPriceCacheEntry[];
    const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));

    const index = await buildAliasIndex(ingredientsCol);
    const resolveFn = (rawName: string) => resolve(rawName, index);

    const quarantinedNames = new Set(
      allIngredientDocs
        .filter((d) => d.quarantine === true)
        .map((d) => d.canonical_name.toLowerCase().trim()),
    );

    // NOTE (2026-07-25): the old script read `d.updatedAt` for this stamp, but
    // canonical_price_cache docs have no top-level `updatedAt` — the real
    // timestamp field (per the 2026-07-24 field census) is nested
    // `metadata.fetched_at`. The old script's stamp was silently always 0.
    // Fixed here rather than ported verbatim, since this wrapper is new
    // Workers-specific code (not one of the four parity-gated engine files).
    const priceCacheStamp = allPriceDocs.reduce((max, d) => {
      const fetchedAt = d.metadata?.fetched_at;
      const t = fetchedAt ? new Date(fetchedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);

    const allRecipes = (await recipesCol.find({}).toArray()) as unknown as Array<Recipe & { _id: ObjectIdType }>;

    let processed = 0;
    let coverageSum = 0;
    let withAdjustedDenom = 0;
    let withBasket = 0;
    // Canonical line-weighted metric: summed across every recipe (not gated
    // behind adjustedTotal > 0), matching tools/parity_replay.js's at/ap.
    let adjustedPriceableTotal = 0;
    let adjustedTotalSum = 0;
    const computedAt = new Date().toISOString();

    for (const recipe of allRecipes) {
      const cost = costRecipe(recipe, resolveFn, ingredientsMap, priceMap, quarantinedNames);

      if (!dryRun) {
        await recipeCostCol.updateOne(
          { recipeId: recipe._id },
          { $set: { recipeId: recipe._id, ...cost, computedAt, priceCacheStamp } },
          { upsert: true },
        );
      }

      processed += 1;
      adjustedPriceableTotal += cost.adjustedPriceable;
      adjustedTotalSum += cost.adjustedTotal;
      // Match the old validate_recipe_cost.js methodology: only average over
      // recipes with a non-zero adjusted denominator.
      if (cost.adjustedTotal > 0) {
        coverageSum += cost.adjustedCoveragePct;
        withAdjustedDenom += 1;
      }
      if (cost.basket > 0) withBasket += 1;
    }

    return {
      dryRun,
      processed,
      avgAdjustedCoveragePct: withAdjustedDenom ? coverageSum / withAdjustedDenom : 0,
      adjustedPriceableTotal,
      adjustedTotalSum,
      lineWeightedAdjustedPct: adjustedTotalSum ? (adjustedPriceableTotal / adjustedTotalSum) * 100 : 0,
      withBasket,
      priceCacheStamp,
    };
  });
}
