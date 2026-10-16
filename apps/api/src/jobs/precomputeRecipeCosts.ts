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
 *
 * 2026-10-16 (cc_prompt_price_refresh_monthly_cron.md Part 3): the computation + write now live in recipeCostGate.ts, which
 * refuses to write ANYTHING when a public recipe trips the anomaly gate (per-serving > £8, drop > 50%, tier change). Before this
 * the weekly cron wrote unreviewed changes straight to production. On a trip the cron sends the anomalies to Telegram.
 */
import { withDb, type DbEnv } from "../db";
import { recomputeRecipeCostsGated, type GateAnomaly } from "./recipeCostGate";

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
  /** true when recipe_cost was actually written (false on dryRun, or when the anomaly gate tripped). */
  wrote: boolean;
  /** Public recipes that tripped the gate. Non-empty => nothing was written. */
  gateAnomalies: GateAnomaly[];
}

/**
 * @param dryRun - when true, computes and returns the summary but never writes
 *   to `recipe_cost` (no createIndex, no updateOne). Use for verifying against
 *   production data before the first real populate.
 */
export async function precomputeRecipeCosts(env: DbEnv, dryRun = false): Promise<PrecomputeSummary> {
  return withDb(env, async (db) => {
    const r = await recomputeRecipeCostsGated(db, { write: !dryRun });
    return {
      dryRun,
      processed: r.recipes,
      avgAdjustedCoveragePct: r.avgAdjustedCoveragePct,
      adjustedPriceableTotal: r.adjustedPriceableTotal,
      adjustedTotalSum: r.adjustedTotalSum,
      lineWeightedAdjustedPct: r.lineWeightedAdjustedPct,
      withBasket: r.withBasket,
      priceCacheStamp: r.priceCacheStamp,
      wrote: r.wrote,
      gateAnomalies: r.anomalies,
    };
  });
}
