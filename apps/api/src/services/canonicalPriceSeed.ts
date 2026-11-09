/**
 * Seed a `canonical_price_cache` doc for a canonical that has NONE (added 2026-11-09): the weekly refresh (jobs/priceRefresh.ts)
 * only updates existing price docs, so a canonical created later (e.g. `single cream`, split out of "single or double cream" on
 * 2026-09-09) stays unpriced forever. The refresh run doc / Telegram summary now lists those as `missingPriceDoc`.
 *
 *   dry run  — evaluates listings with the same guards as the refresh (title matcher of the TARGET canonical, pack parse, 3x outlier,
 *              n>=2), stores them as a preview (`price_seed_previews`, id returned) and projects recipe_cost with the new doc
 *              (anomaly gate + per-recipe changes). Nothing is written to the price cache.
 *   write    — `?write=true` + `previewId`: inserts exactly the reviewed preview (never re-fetches), only if the name still has no doc.
 *   rollback — deletes a seeded doc only while it still carries this batch's `metadata.seed_batch` and no refresh has written it since.
 *
 * Listing sources: `copyFrom` (another price doc's stored listings, 0 Serper credits — e.g. the quarantined "single cream (_milk_)")
 * or Serper (same query as the refresh, ~2-4 credits per name). There is deliberately no unattended creation: with no current value
 * the rise/drop guards have nothing to compare with, so a human reviews the dry run first.
 * The seeded doc keeps `metadata.source: "serper"` and only standard keys, so the weekly refresh takes it over (liveProtectReasons).
 * After a write, run POST /api/admin/recompute-costs (dry run first).
 */
import type { Db, Document } from "mongodb";
import * as G from "./priceRefreshGuard";
import { applySet, fetchDoc } from "../jobs/priceRefresh";
import { recomputeRecipeCostsGated } from "../jobs/recipeCostGate";

const MAX_NAMES = 20;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PREVIEWS = "price_seed_previews";
const FIELD = "__seed__";

export class PriceSeedInputError extends Error {}

export interface PriceSeedInput {
  names?: unknown;
  copyFrom?: unknown;
  previewId?: unknown;
  note?: unknown;
}

type Listing = { store?: string; title?: string; price?: unknown };
interface SeedRow {
  name: string;
  status: "would_seed" | "seeded" | "hold" | "refused" | "fetch_error";
  reason?: string;
  listingSource: string;
  rawCount: number;
  perUnitMetric?: unknown;
  perUnitCount?: unknown;
  cheapest?: unknown;
  confidence?: unknown;
  kept?: Array<{ store?: string; title?: string; price: unknown; per_unit: unknown }>;
  dropped?: Array<{ store?: string; title?: string; reason: string }>;
  credits?: number;
}

const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** pure: guard-evaluate listings for a canonical that has no price doc; returns the doc to insert when the decision is `update` */
export function evaluateSeed(canon: Document, listings: Listing[], source: { label: string; attempts: number | null }) {
  const name = String(canon.canonical_name);
  const ctx: G.GuardCtx = { matcher: G.makeTitleMatcher(canon), referencePack: (canon.reference_pack as G.Pack | undefined) ?? null };
  const raw = listings.map((l) => ({ store: l.store, title: l.title, price: l.price }));
  const { g, decision } = G.evaluateListings(raw, G.curSnapshot({}), ctx, false);
  const rows = g.rows as Array<{ store?: string; title?: string; price: unknown; per_unit: unknown; status: string; reason: string | null }>;
  const kept = rows.filter((r) => r.status === "kept" || r.status === "ambiguous").map((r) => ({ store: r.store, title: r.title, price: r.price, per_unit: r.per_unit }));
  const dropped = rows.filter((r) => r.status === "dropped").map((r) => ({ store: r.store, title: r.title, reason: String(r.reason) }));
  let doc: Document | null = null;
  if (decision.action === "update") {
    const set = G.buildUpdateSet(name, g, decision, raw.length, source.attempts);
    set["metadata.seed_source"] = source.label;
    doc = applySet({ canonical_name: name, per_unit_metric: null, per_unit_count: null }, set);
  }
  return { decision, g, kept, dropped, doc };
}

async function checkTarget(db: Db, name: string): Promise<{ canon: Document } | { refused: string }> {
  if (!name || name.startsWith("__")) return { refused: "invalid_name" };
  const canon = await db.collection("canonical_ingredients").findOne({ canonical_name: name });
  if (!canon) return { refused: "no_canonical_ingredients_doc" };
  if (canon.quarantine === true) return { refused: "quarantined" };
  if (await db.collection("canonical_price_cache").findOne({ canonical_name: name }, { projection: { _id: 1 } })) return { refused: "price_doc_exists" };
  if (await db.collection("price_refresh_overrides").findOne({ name }, { projection: { _id: 1 } })) return { refused: "has_override" };
  return { canon };
}

export async function seedCanonicalPrices(db: Db, env: { SERPER_API_KEY?: string }, body: PriceSeedInput | null, write: boolean) {
  const previewId = str(body?.previewId, 80);
  if (write) return writeFromPreview(db, previewId, str(body?.note, 300) || null);

  const names = Array.isArray(body?.names) ? [...new Set((body!.names as unknown[]).map((n) => str(n)).filter(Boolean))] : [];
  if (!names.length || names.length > MAX_NAMES) throw new PriceSeedInputError(`names must be 1-${MAX_NAMES} canonical names`);
  const copyFrom = str(body?.copyFrom) || null;
  if (copyFrom && names.length !== 1) throw new PriceSeedInputError("copyFrom works with exactly 1 name");
  let copyListings: Listing[] | null = null;
  if (copyFrom) {
    const src = await db.collection("canonical_price_cache").findOne({ canonical_name: copyFrom }, { projection: { listings: 1 } });
    if (!src) throw new PriceSeedInputError(`copyFrom: no canonical_price_cache doc named "${copyFrom}"`);
    copyListings = Array.isArray(src.listings) ? (src.listings as Listing[]) : [];
  } else if (!env.SERPER_API_KEY) throw new PriceSeedInputError("SERPER_API_KEY not configured (use copyFrom)");

  const rows: SeedRow[] = [];
  const toInsert: Array<{ name: string; doc: Document }> = [];
  for (const name of names) {
    const t = await checkTarget(db, name);
    if ("refused" in t) { rows.push({ name, status: "refused", reason: t.refused, listingSource: copyFrom ? `copy:${copyFrom}` : "serper", rawCount: 0 }); continue; }
    let listings: Listing[];
    let label: string;
    let attempts: number | null = null;
    let credits = 0;
    if (copyListings) { listings = copyListings; label = `copy:${copyFrom}`; }
    else {
      const f = await fetchDoc(env.SERPER_API_KEY as string, name);
      credits = f.calls.reduce((s, c) => s + c.credits, 0);
      if (f.error) { rows.push({ name, status: "fetch_error", reason: f.error, listingSource: "serper", rawCount: 0, credits }); continue; }
      listings = f.listings; label = "serper"; attempts = f.calls.length;
    }
    const ev = evaluateSeed(t.canon, listings, { label, attempts });
    rows.push({
      name, status: ev.doc ? "would_seed" : "hold", reason: `${ev.decision.action}:${ev.decision.reason}`, listingSource: label, rawCount: listings.length,
      perUnitMetric: ev.g.per_unit_metric, perUnitCount: ev.g.per_unit_count, cheapest: ev.g.cheapest, confidence: ev.g.confidence,
      kept: ev.kept, dropped: ev.dropped, ...(credits ? { credits } : {}),
    });
    if (ev.doc) toInsert.push({ name, doc: ev.doc });
  }

  const overlay = new Map(toInsert.map((x) => [x.name, x.doc]));
  const rc = overlay.size ? await recomputeRecipeCostsGated(db, { write: false, priceOverlay: overlay, changedDetail: true }) : null;
  let newPreviewId: string | null = null;
  if (toInsert.length) {
    newPreviewId = `cpsp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await db.collection(PREVIEWS).insertOne({ previewId: newPreviewId, at: new Date(), docs: toInsert, anomalies: rc?.anomalies ?? [], used: false });
  }
  return {
    write: false,
    previewId: newPreviewId,
    rows,
    recipeCost: rc ? { anomalies: rc.anomalies, changed: rc.changed ?? [] } : null,
    /** POST { previewId } with ?write=true to insert exactly these docs */
    writeWith: newPreviewId ? { previewId: newPreviewId } : null,
  };
}

async function writeFromPreview(db: Db, previewId: string, note: string | null) {
  if (!/^cpsp-[\w-]+$/.test(previewId)) throw new PriceSeedInputError("write needs previewId (cpsp-*) from a dry run");
  const p = await db.collection(PREVIEWS).findOne({ previewId });
  if (!p) throw new PriceSeedInputError(`no preview ${previewId}`);
  if (p.used) throw new PriceSeedInputError(`preview ${previewId} already written (batch ${p.batch})`);
  if (Date.now() - new Date(p.at).getTime() > PREVIEW_MAX_AGE_MS) throw new PriceSeedInputError("preview older than 7 days — run the dry run again");
  if (Array.isArray(p.anomalies) && p.anomalies.length) throw new PriceSeedInputError(`preview has ${p.anomalies.length} recipe_cost anomaly(ies) — not written`);

  const batch = `cps-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const now = new Date();
  const col = db.collection<Document>("canonical_price_cache");
  const out: Array<{ name: string; status: string }> = [];
  for (const { name, doc } of p.docs as Array<{ name: string; doc: Document }>) {
    const t = await checkTarget(db, name);
    if ("refused" in t) { out.push({ name, status: `refused:${t.refused}` }); continue; }
    const { _id, ...rest } = doc;
    void _id;
    const insert: Document = { ...rest, metadata: { ...(rest.metadata as Document), fetched_at: now, seed_batch: batch } };
    const res = await col.updateOne({ canonical_name: name }, { $setOnInsert: insert }, { upsert: true });
    if (!res.upsertedCount) { out.push({ name, status: "refused:price_doc_exists" }); continue; }
    await db.collection("canonical_backups").insertOne({ batch, canonical_name: name, field: FIELD, before: null, after: insert, note, at: now });
    out.push({ name, status: "seeded" });
  }
  await db.collection(PREVIEWS).updateOne({ previewId }, { $set: { used: true, batch, writtenAt: now } });
  return { write: true, batch, previewId, rows: out, rollbackWith: { batch }, next: "POST /api/admin/recompute-costs (dry run first)" };
}

export async function rollbackCanonicalPriceSeed(db: Db, batchInput: unknown, write: boolean) {
  const batch = typeof batchInput === "string" ? batchInput.trim() : "";
  if (!/^cps-[\w-]+$/.test(batch)) throw new PriceSeedInputError("batch must be a cps-* batch id");
  const rows = await db.collection("canonical_backups").find({ batch, field: FIELD }).toArray();
  if (!rows.length) throw new PriceSeedInputError(`no backups for batch ${batch}`);
  const col = db.collection<Document>("canonical_price_cache");
  const out: Array<{ canonical_name: string; status: string }> = [];
  for (const r of rows) {
    const cur = await col.findOne({ canonical_name: r.canonical_name }, { projection: { refreshBatch: 1, "metadata.seed_batch": 1 } });
    if (!cur || (cur.metadata as Document | undefined)?.seed_batch !== batch || cur.refreshBatch) {
      out.push({ canonical_name: String(r.canonical_name), status: cur ? "skipped_changed_since" : "skipped_missing" });
      continue;
    }
    if (write) await col.deleteOne({ _id: cur._id, "metadata.seed_batch": batch, refreshBatch: { $exists: false } });
    out.push({ canonical_name: String(r.canonical_name), status: write ? "deleted" : "would_delete" });
  }
  return { write, batch, rows: out };
}
