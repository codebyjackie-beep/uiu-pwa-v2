/**
 * Clerk dev -> production instance cutover: rewrite every old Clerk user id to its new one.
 * Worker port of scripts/clerk_user_remap.cjs + clerk_user_remap_rollback.cjs (same logic, same field names,
 * same `clerkRemapPrev` / `clerkRemapBatch` tags, so either tool can roll back the other's batch).
 *
 *   - 10 per-user collections: `userId` field.
 *   - meal_plan_sequence: `_id` = Clerk id (immutable -> insert a copy under the new _id, delete the old doc).
 *   - users: `clerkUserId`. Once the new instance is live, /users/sync has already created a fresh users doc per
 *     new id; it is parked on the old doc (`clerkRemapDeletedDup`) and removed, so the old doc survives.
 *
 * Extra over the script: before any write, full pre-images of every doc the batch touches go to
 * `clerk_remap_backups` ({ batch, collection, docId, doc }), and `scratchVerify` runs write + rollback against a
 * throwaway copy of the 12 collections on the same cluster and diffs a canonical snapshot.
 */
import type { Db, Document, MongoClient } from "mongodb";
import { getMongoModule, type DbEnv } from "../db";

export const USERID_COLLECTIONS = [
  "fridge_stock",
  "meal_plan_sets",
  "meal_plans",
  "user_health_profiles",
  "weight_logs",
  "meal_logs",
  "nutrition_coach_history",
  "favourite_recipes",
  "shopping_list_items",
  "recipe_browse_state",
] as const;
export const SEQUENCE_COLLECTION = "meal_plan_sequence";
export const USERS_COLLECTION = "users";
export const ALL_COLLECTIONS = [...USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION];
const UNIQUE_USER_COLLECTIONS = ["user_health_profiles", "recipe_browse_state"];
const BACKUP_COLLECTION = "clerk_remap_backups";
const ID_RE = /^[A-Za-z0-9_]+$/;

export class RemapInputError extends Error {}

export type RemapInput = {
  map?: { oldId: string; newId: string }[];
  byEmail?: { email: string; newId: string }[];
};
export type RemapPair = { oldId: string; newId: string; how: string };
type Row = { collection: string; oldId: string; newId: string; oldDocs: number; newBefore: number; expectedNew: number; note?: string };
type Unmapped = { collection: string; field: string; value: unknown; docs: number; email?: string };

export type RemapPlan = {
  pairs: RemapPair[];
  summary: { collection: string; willRemap: number; newIdAlreadyThere: number }[];
  totalToRemap: number;
  rows: Row[];
  unmapped: Unmapped[];
  blockers: string[];
  warnings: string[];
};

export type RemapWriteResult = RemapPlan & {
  batch: string;
  backedUp: number;
  requery: (Row & { oldAfter: number; newAfter: number; ok: boolean })[];
  requeryAllOk: boolean;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function resolvePairs(db: Db, input: RemapInput): Promise<RemapPair[]> {
  const pairs: RemapPair[] = [];
  for (const m of input.map ?? []) {
    if (!m?.oldId || !m?.newId) throw new RemapInputError("map entries need oldId and newId");
    pairs.push({ oldId: m.oldId, newId: m.newId, how: "map" });
  }
  for (const m of input.byEmail ?? []) {
    if (!m?.email || !m?.newId) throw new RemapInputError("byEmail entries need email and newId");
    // /users/sync on the new instance may already have a doc for this email under the NEW id — skip that one.
    const docs = await db
      .collection(USERS_COLLECTION)
      .find({ email: { $regex: `^${escapeRegex(m.email)}$`, $options: "i" }, clerkUserId: { $ne: m.newId } })
      .toArray();
    if (docs.length !== 1) throw new RemapInputError(`byEmail ${m.email}: expected exactly 1 old users doc (excluding ${m.newId}), found ${docs.length}`);
    pairs.push({ oldId: String(docs[0]!.clerkUserId), newId: m.newId, how: `email:${m.email}` });
  }
  if (!pairs.length) throw new RemapInputError("give map [{oldId,newId}] and/or byEmail [{email,newId}]");
  const olds = new Set<string>();
  const news = new Set<string>();
  for (const { oldId, newId } of pairs) {
    if (!ID_RE.test(oldId) || !ID_RE.test(newId)) throw new RemapInputError(`ids must match ${ID_RE}: ${oldId} / ${newId}`);
    if (!newId.startsWith("user_")) throw new RemapInputError(`new id must start with user_: ${newId}`);
    if (oldId === newId) throw new RemapInputError(`old and new id are identical: ${oldId}`);
    if (olds.has(oldId)) throw new RemapInputError(`old id mapped twice: ${oldId}`);
    if (news.has(newId)) throw new RemapInputError(`new id used twice: ${newId}`);
    olds.add(oldId);
    news.add(newId);
  }
  for (const n of news) if (olds.has(n)) throw new RemapInputError(`new id ${n} is also an old id (chain/swap) — refusing`);
  return pairs;
}

export async function planRemap(db: Db, pairs: RemapPair[]): Promise<RemapPlan> {
  const rows: Row[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unmapped: Unmapped[] = [];
  const allIds = [...pairs.map((p) => p.oldId), ...pairs.map((p) => p.newId)];

  for (const name of USERID_COLLECTIONS) {
    const col = db.collection(name);
    for (const { oldId: o, newId: n } of pairs) {
      const oldDocs = await col.countDocuments({ userId: o });
      const newBefore = await col.countDocuments({ userId: n });
      const alreadyTagged = await col.countDocuments({ userId: o, clerkRemapBatch: { $exists: true } });
      if (alreadyTagged) blockers.push(`${name}: ${alreadyTagged} doc(s) under ${o} already carry clerkRemapBatch (would lose the rollback chain)`);
      if (UNIQUE_USER_COLLECTIONS.includes(name) && oldDocs && newBefore) blockers.push(`${name}: ${o} and ${n} both already have a doc (unique userId)`);
      if (name === "favourite_recipes" && oldDocs && newBefore) {
        const oldR = new Set((await col.find({ userId: o }, { projection: { recipeId: 1 } }).toArray()).map((d) => String(d.recipeId)));
        const clash = (await col.find({ userId: n }, { projection: { recipeId: 1 } }).toArray()).filter((d) => oldR.has(String(d.recipeId))).length;
        if (clash) blockers.push(`favourite_recipes: ${clash} recipeId(s) favourited under both ${o} and ${n} (unique {userId,recipeId})`);
      }
      rows.push({ collection: name, oldId: o, newId: n, oldDocs, newBefore, expectedNew: newBefore + oldDocs });
    }
    const others = await col.aggregate([{ $match: { userId: { $nin: allIds } } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]).toArray();
    for (const g of others) unmapped.push({ collection: name, field: "userId", value: g._id, docs: g.n });
  }

  const seq = db.collection<Document>(SEQUENCE_COLLECTION);
  for (const { oldId: o, newId: n } of pairs) {
    const oldDocs = await seq.countDocuments({ _id: o as unknown as Document["_id"] });
    const newBefore = await seq.countDocuments({ _id: n as unknown as Document["_id"] });
    if (oldDocs && newBefore) blockers.push(`${SEQUENCE_COLLECTION}: _id ${n} already exists (would overwrite its nextPlanNumber)`);
    if (oldDocs && (await seq.countDocuments({ _id: o as unknown as Document["_id"], clerkRemapBatch: { $exists: true } }))) blockers.push(`${SEQUENCE_COLLECTION}: ${o} already remapped`);
    rows.push({ collection: SEQUENCE_COLLECTION, oldId: o, newId: n, oldDocs, newBefore, expectedNew: oldDocs ? 1 : newBefore });
  }
  for (const g of await seq.find({ _id: { $nin: allIds as unknown as Document["_id"][] } }).toArray()) {
    unmapped.push({ collection: SEQUENCE_COLLECTION, field: "_id", value: g._id, docs: 1 });
  }

  const users = db.collection(USERS_COLLECTION);
  for (const { oldId: o, newId: n } of pairs) {
    const oldDocs = await users.countDocuments({ clerkUserId: o });
    const newBefore = await users.countDocuments({ clerkUserId: n });
    if (oldDocs > 1) blockers.push(`users: ${oldDocs} docs for ${o}`);
    if (newBefore > 1) blockers.push(`users: ${newBefore} docs for ${n}`);
    if (oldDocs && (await users.countDocuments({ clerkUserId: o, clerkRemapBatch: { $exists: true } }))) blockers.push(`users: ${o} already remapped`);
    rows.push({
      collection: USERS_COLLECTION,
      oldId: o,
      newId: n,
      oldDocs,
      newBefore,
      expectedNew: oldDocs ? 1 : newBefore,
      note: oldDocs && newBefore ? "fresh /sync duplicate under new id will be folded into the old doc" : "",
    });
  }
  for (const g of await users.find({ clerkUserId: { $nin: allIds } }, { projection: { clerkUserId: 1, email: 1 } }).toArray()) {
    unmapped.push({ collection: USERS_COLLECTION, field: "clerkUserId", value: g.clerkUserId, docs: 1, email: g.email });
  }

  for (const { oldId: o } of pairs) if (!rows.some((r) => r.oldId === o && r.oldDocs)) warnings.push(`${o} has no docs anywhere`);

  const summary = ALL_COLLECTIONS.map((name) => {
    const rs = rows.filter((r) => r.collection === name);
    return { collection: name, willRemap: rs.reduce((a, r) => a + r.oldDocs, 0), newIdAlreadyThere: rs.reduce((a, r) => a + r.newBefore, 0) };
  });
  return { pairs, summary, totalToRemap: summary.reduce((a, s) => a + s.willRemap, 0), rows, unmapped, blockers, warnings };
}

function newBatchId(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = crypto.getRandomValues(new Uint8Array(3));
  return `clerkremap_${d}_${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Writes the remap. Caller must have checked `plan.blockers` is empty. */
export async function writeRemap(db: Db, plan: RemapPlan): Promise<RemapWriteResult> {
  if (plan.blockers.length) throw new RemapInputError(`blockers present: ${plan.blockers.join("; ")}`);
  const batch = newBatchId();
  const pairs = plan.pairs;
  const oldIds = pairs.map((p) => p.oldId);
  const newIds = pairs.map((p) => p.newId);
  const at = new Date();

  // ---- backup: full pre-image of every doc this batch can touch ----
  const backups: Document[] = [];
  for (const name of USERID_COLLECTIONS) {
    for (const doc of await db.collection(name).find({ userId: { $in: oldIds } }).toArray()) backups.push({ batch, at, collection: name, docId: doc._id, doc });
  }
  const seq = db.collection<Document>(SEQUENCE_COLLECTION);
  for (const doc of await seq.find({ _id: { $in: oldIds as unknown as Document["_id"][] } }).toArray()) backups.push({ batch, at, collection: SEQUENCE_COLLECTION, docId: doc._id, doc });
  const users = db.collection(USERS_COLLECTION);
  for (const doc of await users.find({ clerkUserId: { $in: [...oldIds, ...newIds] } }).toArray()) backups.push({ batch, at, collection: USERS_COLLECTION, docId: doc._id, doc });
  if (backups.length) await db.collection(BACKUP_COLLECTION).insertMany(backups);

  // ---- write ----
  for (const name of USERID_COLLECTIONS) {
    for (const { oldId: o, newId: n } of pairs) {
      await db.collection(name).updateMany({ userId: o }, [{ $set: { clerkRemapPrev: "$userId", userId: { $literal: n }, clerkRemapBatch: { $literal: batch } } }]);
    }
  }
  for (const { oldId: o, newId: n } of pairs) {
    const doc = await seq.findOne({ _id: o as unknown as Document["_id"] });
    if (doc) {
      await seq.insertOne({ ...doc, _id: n as unknown as Document["_id"], clerkRemapPrev: o, clerkRemapBatch: batch, clerkRemapPrevDoc: doc });
      await seq.deleteOne({ _id: o as unknown as Document["_id"] });
    }
  }
  for (const { oldId: o, newId: n } of pairs) {
    const oldDoc = await users.findOne({ clerkUserId: o });
    if (!oldDoc) continue;
    const dup = await users.findOne({ clerkUserId: n });
    // 1) park the duplicate on the old doc, 2) delete it (unique clerkUserId), 3) switch the old doc to the new id.
    await users.updateOne({ _id: oldDoc._id }, { $set: { clerkRemapPrev: o, clerkRemapBatch: batch, ...(dup ? { clerkRemapDeletedDup: dup } : {}) } });
    if (dup) await users.deleteOne({ _id: dup._id });
    await users.updateOne({ _id: oldDoc._id }, { $set: { clerkUserId: n } });
  }

  // ---- re-query ----
  const requery: RemapWriteResult["requery"] = [];
  for (const r of plan.rows) {
    let oldAfter: number;
    let newAfter: number;
    if (r.collection === SEQUENCE_COLLECTION) {
      oldAfter = await seq.countDocuments({ _id: r.oldId as unknown as Document["_id"] });
      newAfter = await seq.countDocuments({ _id: r.newId as unknown as Document["_id"] });
    } else if (r.collection === USERS_COLLECTION) {
      oldAfter = await users.countDocuments({ clerkUserId: r.oldId });
      newAfter = await users.countDocuments({ clerkUserId: r.newId });
    } else {
      oldAfter = await db.collection(r.collection).countDocuments({ userId: r.oldId });
      newAfter = await db.collection(r.collection).countDocuments({ userId: r.newId });
    }
    requery.push({ ...r, oldAfter, newAfter, ok: oldAfter === 0 && newAfter === r.expectedNew });
  }
  return { ...plan, batch, backedUp: backups.length, requery, requeryAllOk: requery.every((x) => x.ok) };
}

export type RollbackResult = { batch: string; write: boolean; rows: { collection: string; tagged: number }[]; total: number; leftAfter?: number };

export async function rollbackRemap(db: Db, batch: string, write: boolean): Promise<RollbackResult> {
  if (!/^clerkremap_\d{8}_[0-9a-f]{6}$/.test(batch)) throw new RemapInputError("batch must look like clerkremap_YYYYMMDD_xxxxxx");
  const rows: RollbackResult["rows"] = [];
  for (const name of USERID_COLLECTIONS) {
    const col = db.collection(name);
    const tagged = await col.countDocuments({ clerkRemapBatch: batch });
    rows.push({ collection: name, tagged });
    if (write && tagged) await col.updateMany({ clerkRemapBatch: batch }, [{ $set: { userId: "$clerkRemapPrev" } }, { $unset: ["clerkRemapPrev", "clerkRemapBatch"] }]);
  }
  const seq = db.collection<Document>(SEQUENCE_COLLECTION);
  const seqDocs = await seq.find({ clerkRemapBatch: batch }).toArray();
  rows.push({ collection: SEQUENCE_COLLECTION, tagged: seqDocs.length });
  if (write) {
    for (const d of seqDocs) {
      if (await seq.countDocuments({ _id: d.clerkRemapPrev })) throw new Error(`meal_plan_sequence ${d.clerkRemapPrev} already exists — resolve by hand`);
      await seq.insertOne(d.clerkRemapPrevDoc);
      await seq.deleteOne({ _id: d._id });
    }
  }
  const users = db.collection(USERS_COLLECTION);
  const userDocs = await users.find({ clerkRemapBatch: batch }).toArray();
  rows.push({ collection: USERS_COLLECTION, tagged: userDocs.length });
  if (write) {
    for (const d of userDocs) {
      await users.updateOne({ _id: d._id }, { $set: { clerkUserId: d.clerkRemapPrev }, $unset: { clerkRemapPrev: "", clerkRemapBatch: "", clerkRemapDeletedDup: "" } });
      if (d.clerkRemapDeletedDup) await users.insertOne(d.clerkRemapDeletedDup);
    }
  }
  const result: RollbackResult = { batch, write, rows, total: rows.reduce((a, r) => a + r.tagged, 0) };
  if (write) {
    let left = 0;
    for (const n of ALL_COLLECTIONS) left += await db.collection(n).countDocuments({ clerkRemapBatch: batch });
    result.leftAfter = left;
  }
  return result;
}

// ---------------- scratch verification ----------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object" && v.constructor === Object) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

async function snapshot(db: Db): Promise<Record<string, string[]>> {
  const { BSON } = await getMongoModule();
  const out: Record<string, string[]> = {};
  for (const name of ALL_COLLECTIONS) {
    const docs = await db.collection(name).find({}).toArray();
    out[name] = docs.map((d) => JSON.stringify(canonical(JSON.parse(BSON.EJSON.stringify(d, { relaxed: false }))))).sort();
  }
  return out;
}

function diff(a: Record<string, string[]>, b: Record<string, string[]>) {
  const res: Record<string, { before: number; after: number; onlyBefore: number; onlyAfter: number }> = {};
  for (const k of ALL_COLLECTIONS) {
    const ak = a[k] ?? [];
    const bk = b[k] ?? [];
    const sa = new Set(ak);
    const sb = new Set(bk);
    res[k] = { before: ak.length, after: bk.length, onlyBefore: ak.filter((x) => !sb.has(x)).length, onlyAfter: bk.filter((x) => !sa.has(x)).length };
  }
  return res;
}

const sameSnap = (a: Record<string, string[]>, b: Record<string, string[]>) => Object.values(diff(a, b)).every((d) => d.onlyBefore === 0 && d.onlyAfter === 0 && d.before === d.after);

/**
 * Copies the 12 collections (+ indexes) into a scratch DB on the same cluster, simulates the /sync duplicates
 * for the new ids, runs plan -> write -> rollback dry-run -> rollback write, diffs snapshots, drops the scratch DB.
 * The production DB is only read. New ids here must be fake (user_TEST_…).
 */
export async function scratchVerify(env: DbEnv, input: RemapInput) {
  for (const m of [...(input.map ?? []), ...(input.byEmail ?? [])]) {
    if (!m.newId?.startsWith("user_TEST_")) throw new RemapInputError("scratch-verify only accepts fake new ids starting with user_TEST_");
  }
  const { MongoClient } = await getMongoModule();
  const client: MongoClient = new MongoClient(env.MONGODB_URI);
  const scratchName = `uiu_remap_scratch_${Date.now()}`;
  const result: Record<string, unknown> = { scratchDb: scratchName };
  try {
    await client.connect();
    const prod = client.db(env.MONGODB_DB);
    const db = client.db(scratchName);
    for (const name of ALL_COLLECTIONS) {
      const docs = await prod.collection(name).find({}).toArray();
      if (docs.length) await db.collection(name).insertMany(docs);
      const idx = (await prod.collection(name).indexes().catch(() => [])).filter((i) => i.name !== "_id_");
      for (const i of idx) {
        const { key, name: iname, unique, sparse, partialFilterExpression } = i as Document;
        await db.collection(name).createIndex(key, { name: iname, ...(unique ? { unique } : {}), ...(sparse ? { sparse } : {}), ...(partialFilterExpression ? { partialFilterExpression } : {}) });
      }
    }
    const pairs = await resolvePairs(db, input);
    result.pairs = pairs;
    // simulate /users/sync having created fresh docs under the new ids
    for (const p of pairs) {
      const src = await db.collection(USERS_COLLECTION).findOne({ clerkUserId: p.oldId });
      await db.collection(USERS_COLLECTION).insertOne({ clerkUserId: p.newId, email: src?.email ?? null, createdAt: new Date(), simulatedSyncDup: true });
    }
    const before = await snapshot(db);
    const plan = await planRemap(db, pairs);
    result.plan = { summary: plan.summary, totalToRemap: plan.totalToRemap, unmapped: plan.unmapped, blockers: plan.blockers, warnings: plan.warnings };
    result.dryRunWroteNothing = sameSnap(before, await snapshot(db));
    if (plan.blockers.length) {
      result.stoppedOnBlockers = true;
      return result;
    }
    const w = await writeRemap(db, plan);
    result.batch = w.batch;
    result.backedUp = w.backedUp;
    result.requeryAllOk = w.requeryAllOk;
    result.requery = w.requery.filter((r) => r.expectedNew || r.oldAfter);
    // the backup collection is new in scratch — leave it out of the comparison
    const mid = await snapshot(db);
    result.writeChangedSomething = !sameSnap(before, mid);
    const rbDry = await rollbackRemap(db, w.batch, false);
    result.rollbackDryRunTotal = rbDry.total;
    result.rollbackDryRunWroteNothing = sameSnap(mid, await snapshot(db));
    const rb = await rollbackRemap(db, w.batch, true);
    result.rollbackLeftAfter = rb.leftAfter;
    const after = await snapshot(db);
    result.diffAfterRollback = diff(before, after);
    result.zeroDiff = sameSnap(before, after);
    return result;
  } finally {
    try {
      await client.db(scratchName).dropDatabase();
      result.scratchDropped = true;
    } catch {
      result.scratchDropped = false;
    }
    await client.close();
  }
}
