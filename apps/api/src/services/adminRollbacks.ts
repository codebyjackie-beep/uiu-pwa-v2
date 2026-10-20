/**
 * Worker ports of two local rollback scripts so a bad price refresh can be undone from cloud over HTTPS:
 *   - scripts/price_refresh_rollback.cjs        -> priceRefreshRollback()
 *   - scripts/recipe_cost_recompute_rollback.cjs -> recipeCostRollback()
 * Same markers and the same restore rules as the scripts (refreshPrev / refreshBatch / refreshAt on canonical_price_cache;
 * costFixPrev / costFixBatch on recipe_cost). Dry run unless `write` is true.
 *
 * After a price rollback, recipe_cost still reflects the rolled-back prices: run POST /api/admin/recompute-costs (dry run first).
 */
import type { Db, Document } from "mongodb";

export class RollbackInputError extends Error {}

const BATCH_RE = /^[A-Za-z0-9_-]{3,64}$/;

// ---------------- canonical_price_cache ----------------

const EXPLICIT_NULL = ["per_unit_metric", "per_unit_count", "cheapest"] as const;
const UNSET_WHEN_NULL = ["n_supermarkets", "listings", "confidence", "needs_review", "price_basis", "curation_note"] as const;
const same = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9);

type Plan = { $set: Record<string, unknown>; $unset: Record<string, ""> };

function restorePlan(d: Document): Plan {
  const prev = d.refreshPrev as Record<string, unknown>;
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ""> = { refreshPrev: "", refreshBatch: "", refreshAt: "" };
  for (const k of EXPLICIT_NULL) $set[k] = prev[k] ?? null;
  for (const k of UNSET_WHEN_NULL) {
    if (prev[k] === null || prev[k] === undefined) $unset[k] = "";
    else $set[k] = prev[k];
  }
  if (prev.metadata) $set.metadata = prev.metadata;
  return { $set, $unset };
}

function snapshotAfter(d: Document, plan: Plan) {
  const v = (k: string): any => (k in plan.$set ? plan.$set[k] : k in plan.$unset ? null : (d[k] ?? null));
  const md = (plan.$set.metadata as Document | undefined) ?? d.metadata;
  return {
    metric: v("per_unit_metric") ? v("per_unit_metric").value : null,
    count: v("per_unit_count") ? v("per_unit_count").value : null,
    cheapestPrice: v("cheapest") ? v("cheapest").price : null,
    n_supermarkets: v("n_supermarkets"),
    confidence: v("confidence"),
    fetched_at: md && md.fetched_at ? new Date(md.fetched_at).toISOString() : null,
  };
}

export type PriceRollbackResult = {
  batch: string;
  write: boolean;
  docs: number;
  verifiedAgainstRun: string | null;
  restoredEqualsPreRefresh: number | null;
  mismatches: { name: string; why?: string; restored?: unknown; runCur?: unknown }[];
  sample: { name: string; metricNow: number | null; metricAfter: number | null; fetchedAfter: string | null }[];
  rolledBack: number;
  leftAfter?: number;
};

export async function priceRefreshRollback(db: Db, batch: string, opts: { write: boolean; verifyRunId?: string | null }): Promise<PriceRollbackResult> {
  if (!BATCH_RE.test(batch)) throw new RollbackInputError("batch must be 3–64 chars of letters, digits, - or _");
  let verify: Map<string, any> | null = null;
  if (opts.verifyRunId) {
    const run = await db.collection("price_refresh_runs").findOne({ runId: opts.verifyRunId });
    if (!run) throw new RollbackInputError(`run ${opts.verifyRunId} not found in price_refresh_runs`);
    if (run.batch !== batch) throw new RollbackInputError(`run ${opts.verifyRunId} wrote batch ${run.batch}, not ${batch}`);
    verify = new Map((run.results as Document[]).filter((x) => x.written === true && x.cur).map((x) => [x.name as string, x.cur]));
  }
  const col = db.collection("canonical_price_cache");
  const docs = await col.find({ refreshBatch: batch }).toArray();
  const result: PriceRollbackResult = { batch, write: opts.write, docs: docs.length, verifiedAgainstRun: opts.verifyRunId ?? null, restoredEqualsPreRefresh: null, mismatches: [], sample: [], rolledBack: 0 };
  if (!docs.length) return result;
  const noPrev = docs.filter((d) => !d.refreshPrev);
  if (noPrev.length) throw new RollbackInputError(`${noPrev.length} doc(s) have refreshBatch but no refreshPrev (${noPrev.slice(0, 5).map((d) => d.canonical_name).join(", ")})`);

  const plans = docs.map((d) => ({ d, plan: restorePlan(d) }));
  if (verify) {
    let ok = 0;
    for (const { d, plan } of plans) {
      const cur = verify.get(d.canonical_name);
      if (!cur) {
        result.mismatches.push({ name: d.canonical_name, why: "not in run results" });
        continue;
      }
      const s = snapshotAfter(d, plan);
      const eq =
        same(s.metric, cur.metric ? cur.metric.value : null) &&
        same(s.count, cur.count ? cur.count.value : null) &&
        same(s.cheapestPrice, cur.cheapest ? cur.cheapest.price : null) &&
        s.n_supermarkets === cur.n_supermarkets &&
        s.confidence === cur.confidence &&
        s.fetched_at === cur.fetched_at;
      if (eq) ok++;
      else result.mismatches.push({ name: d.canonical_name, restored: s, runCur: cur });
    }
    result.restoredEqualsPreRefresh = ok;
  }
  result.sample = plans.slice(0, 8).map(({ d, plan }) => {
    const s = snapshotAfter(d, plan);
    return { name: d.canonical_name, metricNow: d.per_unit_metric ? d.per_unit_metric.value : null, metricAfter: s.metric, fetchedAfter: s.fetched_at };
  });
  if (!opts.write) return result;
  if (result.mismatches.length) throw new RollbackInputError(`${result.mismatches.length} doc(s) would not restore to the pre-refresh snapshot — nothing written`);
  for (const { d, plan } of plans) {
    result.rolledBack += (await col.updateOne({ _id: d._id, refreshBatch: batch }, { $set: plan.$set, $unset: plan.$unset })).modifiedCount;
  }
  result.leftAfter = await col.countDocuments({ refreshBatch: batch });
  return result;
}

// ---------------- recipe_cost ----------------

export type RecipeCostRollbackResult = {
  batch: string;
  write: boolean;
  docs: number;
  willDelete: number;
  sample: { recipeId: string; perServingNow: unknown; perServingAfter: unknown }[];
  restored: number;
  deleted: number;
  leftAfter?: number;
};

export async function recipeCostRollback(db: Db, batch: string, write: boolean): Promise<RecipeCostRollbackResult> {
  if (!BATCH_RE.test(batch)) throw new RollbackInputError("batch must be 3–64 chars of letters, digits, - or _");
  const col = db.collection("recipe_cost");
  const docs = await col.find({ costFixBatch: batch }).toArray();
  const result: RecipeCostRollbackResult = {
    batch,
    write,
    docs: docs.length,
    willDelete: docs.filter((d) => !d.costFixPrev).length,
    sample: docs.slice(0, 10).map((d) => ({ recipeId: String(d.recipeId), perServingNow: d.perServing ?? null, perServingAfter: d.costFixPrev ? (d.costFixPrev.perServing ?? null) : "(remove doc)" })),
    restored: 0,
    deleted: 0,
  };
  if (!write || !docs.length) return result;
  for (const d of docs) {
    if (!d.costFixPrev) {
      result.deleted += (await col.deleteOne({ _id: d._id, costFixBatch: batch })).deletedCount;
      continue;
    }
    const { _id, ...current } = d;
    void _id;
    const unsetKeys = Object.keys(current).filter((k) => !(k in d.costFixPrev) && k !== "recipeId");
    const $unset = Object.fromEntries(unsetKeys.map((k) => [k, ""]));
    // costFixPrev is the full previous doc: an earlier batch marker in it is restored with it (same as the script)
    const $set = { ...d.costFixPrev };
    delete ($set as Document)._id;
    result.restored += (await col.updateOne({ _id: d._id, costFixBatch: batch }, unsetKeys.length ? { $set, $unset } : { $set })).modifiedCount;
  }
  result.leftAfter = await col.countDocuments({ costFixBatch: batch });
  return result;
}
