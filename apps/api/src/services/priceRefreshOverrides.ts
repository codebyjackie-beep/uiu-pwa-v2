/**
 * Manage the price-refresh override list (`price_refresh_overrides`) over HTTPS — added 2026-10-30 because rows could only
 * be removed with a local DB connection, and cloud / local VMs cannot reach Atlas over TCP. A canonical with an override row
 * (keep_old / skip) is NEVER refreshed by the Worker (jobs/priceRefresh.ts buildQueue), so its price stays at whatever it was
 * when the row was written (e.g. mango: 2026-07-20).
 *
 *   list   — every override + the date of the canonical's current price (metadata.fetched_at)
 *   remove — dry run unless `write`; returns the removed rows verbatim so they can be re-added
 *   add    — dry run unless `write`; the exact reverse of remove
 *
 * The `__seed_meta__` marker doc is never listed, removed or added (it stops the seed from re-inserting removed rows).
 * Removing a row does NOT write any price: the canonical simply becomes eligible for the next refresh run / names= dry-run.
 */
import type { Db, Document } from "mongodb";

const OVERRIDES = "price_refresh_overrides";
const DECISIONS = ["keep_old", "skip"] as const;
export type OverrideDecision = (typeof DECISIONS)[number];
const MAX_NAMES = 10;

export class OverrideInputError extends Error {}

export interface OverrideRow {
  canonical_name: string;
  decision: string;
  note: string | null;
  ref: string | null;
  createdAt: string | null;
  /** canonical_price_cache.metadata.fetched_at (ISO) — null when the canonical has no price doc */
  priceFetchedAt: string | null;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

function cleanNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new OverrideInputError("names must be a non-empty array of canonical names");
  const names = [...new Set(input.map((n) => (typeof n === "string" ? n.trim() : "")))];
  if (names.some((n) => !n || n.startsWith("__") || n.length > 120)) throw new OverrideInputError("each name must be a non-empty canonical name (max 120 chars)");
  if (names.length > MAX_NAMES) throw new OverrideInputError(`at most ${MAX_NAMES} names per call`);
  return names;
}

async function withPriceDates(db: Db, rows: Document[]): Promise<OverrideRow[]> {
  const names = rows.map((r) => String(r.canonical_name));
  const prices = names.length
    ? await db.collection<Document>("canonical_price_cache").find({ canonical_name: { $in: names } }).project({ canonical_name: 1, "metadata.fetched_at": 1 }).toArray()
    : [];
  const fetched = new Map(prices.map((p) => [String(p.canonical_name), iso((p.metadata as { fetched_at?: unknown } | undefined)?.fetched_at)]));
  return rows.map((r) => ({
    canonical_name: String(r.canonical_name),
    decision: String(r.decision ?? ""),
    note: typeof r.note === "string" ? r.note : null,
    ref: typeof r.ref === "string" ? r.ref : null,
    createdAt: iso(r.createdAt),
    priceFetchedAt: fetched.get(String(r.canonical_name)) ?? null,
  }));
}

export async function listOverrides(db: Db): Promise<{ count: number; byDecision: Record<string, number>; rows: OverrideRow[] }> {
  const docs = await db.collection<Document>(OVERRIDES).find({ canonical_name: { $exists: true } }).sort({ canonical_name: 1 }).toArray();
  const rows = await withPriceDates(db, docs);
  const byDecision: Record<string, number> = {};
  for (const r of rows) byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
  return { count: rows.length, byDecision, rows };
}

export async function removeOverrides(db: Db, namesInput: unknown, write: boolean) {
  const names = cleanNames(namesInput);
  const col = db.collection<Document>(OVERRIDES);
  const found = await col.find({ canonical_name: { $in: names } }).toArray();
  const rows = await withPriceDates(db, found);
  const foundNames = rows.map((r) => r.canonical_name);
  const notFound = names.filter((n) => !foundNames.includes(n));
  let deleted = 0;
  if (write && foundNames.length) deleted = (await col.deleteMany({ canonical_name: { $in: foundNames } })).deletedCount ?? 0;
  return {
    write,
    requested: names,
    removed: write ? foundNames : [],
    wouldRemove: write ? [] : foundNames,
    notFound,
    deleted,
    /** POST these back to /price-refresh/overrides/add to undo */
    restore: rows.map((r) => ({ name: r.canonical_name, decision: r.decision, note: r.note })),
    rows,
  };
}

export async function addOverride(db: Db, body: { name?: unknown; decision?: unknown; note?: unknown } | null, write: boolean) {
  const [name] = cleanNames([body?.name]);
  const decision = body?.decision;
  if (!DECISIONS.includes(decision as OverrideDecision)) throw new OverrideInputError(`decision must be one of ${DECISIONS.join(", ")}`);
  const note = typeof body?.note === "string" ? body.note.slice(0, 300) : "added via admin endpoint";
  if (!(await db.collection<Document>("canonical_price_cache").findOne({ canonical_name: name }, { projection: { _id: 1 } }))) {
    throw new OverrideInputError(`no canonical_price_cache doc named "${name}"`);
  }
  const col = db.collection<Document>(OVERRIDES);
  const existing = await col.findOne({ canonical_name: name });
  if (existing) return { write, name, added: false, reason: "already_exists", existing: (await withPriceDates(db, [existing]))[0] };
  if (write) {
    await col.updateOne(
      { canonical_name: name },
      { $setOnInsert: { canonical_name: name, decision, note, ref: "admin endpoint 2026-10-30", createdAt: new Date() } },
      { upsert: true },
    );
  }
  return { write, name, added: write, wouldAdd: !write, decision, note };
}
