/**
 * Set / roll back `per_unit_count` on a `canonical_price_cache` doc over HTTPS — added 2026-10-30 for mango: the weekly refresh
 * only fills `per_unit_metric` (£/g) and a canonical with `per_unit_count: null` cannot price "2 mango" lines by the piece
 * (services/recipeCost.ts falls back to per_item_g × £/g, which is wrong for mango: £0.01/g × 336g ≈ £3.4 per mango).
 *
 *   set      — dry run unless `write`; only touches `per_unit_count`; prior value saved to `canonical_backups` under a batch id
 *   rollback — dry run unless `write`; restores the saved prior value only if the doc still holds the value this batch wrote
 *
 * After a write, run POST /api/admin/recompute-costs (dry run first) so recipe_cost follows the new price.
 */
import type { Db, Document } from "mongodb";

const FIELD = "per_unit_count";
const MAX_VALUE = 50;

export class PerUnitCountInputError extends Error {}

export interface PerUnitCountInput {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  n?: unknown;
  note?: unknown;
}

export async function setPerUnitCount(db: Db, body: PerUnitCountInput | null, write: boolean) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.startsWith("__") || name.length > 120) throw new PerUnitCountInputError("name must be a canonical name");
  const value = body?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_VALUE) throw new PerUnitCountInputError(`value must be a number in (0, ${MAX_VALUE}] (GBP per piece)`);
  if (body?.unit !== "each") throw new PerUnitCountInputError('unit must be "each"');
  const n = body?.n == null ? 1 : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100) throw new PerUnitCountInputError("n must be an integer 1-100 (number of listings behind the price)");
  const note = typeof body?.note === "string" ? body.note.slice(0, 300) : null;

  const col = db.collection<Document>("canonical_price_cache");
  const doc = await col.findOne({ canonical_name: name }, { projection: { canonical_name: 1, per_unit_count: 1, per_unit_metric: 1, cheapest: 1 } });
  if (!doc) throw new PerUnitCountInputError(`no canonical_price_cache doc named "${name}"`);
  const before = (doc.per_unit_count ?? null) as Document | null;
  const after = { value, unit: "each", n };
  const batch = `puc-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (write) {
    const res = await col.updateOne({ canonical_name: name }, { $set: { [FIELD]: after } });
    if (!res.matchedCount) throw new PerUnitCountInputError(`doc "${name}" disappeared`);
    await db.collection("canonical_backups").insertOne({ batch, canonical_name: name, field: FIELD, before, after, note, at: new Date() });
  }
  return {
    write,
    batch: write ? batch : null,
    name,
    before,
    after,
    perUnitMetric: doc.per_unit_metric ?? null,
    cheapest: doc.cheapest ?? null,
    /** POST { batch } to /canonical-price/per-unit-count/rollback to undo */
    rollbackWith: write ? { batch } : null,
  };
}

export async function rollbackPerUnitCount(db: Db, batchInput: unknown, write: boolean) {
  const batch = typeof batchInput === "string" ? batchInput.trim() : "";
  if (!/^puc-[\w-]+$/.test(batch)) throw new PerUnitCountInputError("batch must be a puc-* batch id");
  const rows = await db.collection("canonical_backups").find({ batch, field: FIELD }).toArray();
  if (!rows.length) throw new PerUnitCountInputError(`no backups for batch ${batch}`);
  const col = db.collection<Document>("canonical_price_cache");
  const out: Array<{ canonical_name: string; restoreTo: unknown; status: string }> = [];
  for (const r of rows) {
    const cur = await col.findOne({ canonical_name: r.canonical_name }, { projection: { per_unit_count: 1 } });
    const cv = (cur?.per_unit_count as { value?: number } | null | undefined)?.value;
    const av = (r.after as { value?: number } | null)?.value;
    if (!cur || cv !== av) {
      out.push({ canonical_name: String(r.canonical_name), restoreTo: r.before, status: "skipped_changed_since" });
      continue;
    }
    if (write) await col.updateOne({ canonical_name: r.canonical_name }, { $set: { [FIELD]: r.before ?? null } });
    out.push({ canonical_name: String(r.canonical_name), restoreTo: r.before ?? null, status: write ? "restored" : "would_restore" });
  }
  return { write, batch, rows: out };
}
