/**
 * Duplicate-recipe clean-up (Jackie 2026-11-06, list: claude/dupes_2026-11-06.md in the UIU_PWA_V2 project).
 *
 * withdrawRecipes  — hides public recipes: isPublic:false + withdrawnReason + withdrawnAt. Nothing is deleted, so
 *                    restoreWithdrawn() (same reason) puts them back. Dry run unless write.
 * evalSameDish     — read-only: runs the AI same-dish check (services/sameDish.ts) on given recipes against the
 *                    public library minus the recipe itself, so the check can be measured on known duplicates
 *                    (should match) and known keepers (should not) before trusting it.
 */
import type { Db, Document } from "mongodb";
import { getMongoModule } from "../db";
import type { OpenRouterEnv } from "./openrouter";
import { findSameDishLLM, SameDishCheckError } from "./sameDish";

export class RecipeWithdrawInputError extends Error {}

export const WITHDRAW_MAX_IDS = 200;
export const EVAL_MAX_IDS = 10;
const HEX_RE = /^[0-9a-f]{24}$/;
const REASON_RE = /^[a-z0-9-]{3,60}$/;

function parseIds(input: unknown, max: number): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new RecipeWithdrawInputError("ids must be a non-empty array");
  if (input.length > max) throw new RecipeWithdrawInputError(`at most ${max} ids per call`);
  const ids = [...new Set(input.map((x) => String(x).trim().toLowerCase()))];
  const bad = ids.filter((x) => !HEX_RE.test(x));
  if (bad.length) throw new RecipeWithdrawInputError(`not ObjectId hex: ${bad.slice(0, 3).join(", ")}`);
  return ids;
}

function parseReason(input: unknown): string {
  const reason = typeof input === "string" ? input.trim() : "";
  if (!REASON_RE.test(reason)) throw new RecipeWithdrawInputError("reason must be 3-60 chars of a-z, 0-9, -");
  return reason;
}

export async function withdrawRecipes(db: Db, idsInput: unknown, reasonInput: unknown, write: boolean) {
  const ids = parseIds(idsInput, WITHDRAW_MAX_IDS);
  const reason = parseReason(reasonInput);
  const { ObjectId } = await getMongoModule();
  const oids = ids.map((x) => new ObjectId(x));
  const col = db.collection<Document>("recipes");

  const found = await col.find({ _id: { $in: oids } }, { projection: { title: 1, isPublic: 1 } }).toArray();
  const foundIds = new Set(found.map((d) => String(d._id)));
  const notFound = ids.filter((x) => !foundIds.has(x));
  const toHide = found.filter((d) => d.isPublic === true);
  const alreadyHidden = found.length - toHide.length;
  const publicBefore = await col.countDocuments({ isPublic: true });

  let modified = 0;
  if (write && toHide.length) {
    const res = await col.updateMany(
      { _id: { $in: toHide.map((d) => d._id) }, isPublic: true },
      { $set: { isPublic: false, withdrawnReason: reason, withdrawnAt: new Date().toISOString() } },
    );
    modified = res.modifiedCount;
  }
  const publicAfter = write ? await col.countDocuments({ isPublic: true }) : publicBefore - toHide.length;

  return {
    write,
    reason,
    requested: ids.length,
    found: found.length,
    notFound,
    alreadyHidden,
    wouldHide: toHide.length,
    modified,
    publicBefore,
    publicAfter,
    sample: toHide.slice(0, 5).map((d) => String(d.title ?? "")),
  };
}

/** Undo withdrawRecipes for one reason. Dry run unless write. */
export async function restoreWithdrawn(db: Db, reasonInput: unknown, write: boolean) {
  const reason = parseReason(reasonInput);
  const col = db.collection<Document>("recipes");
  const filter = { withdrawnReason: reason, isPublic: false };
  const count = await col.countDocuments(filter);
  let modified = 0;
  if (write && count) {
    const res = await col.updateMany(filter, { $set: { isPublic: true }, $unset: { withdrawnReason: "", withdrawnAt: "" } });
    modified = res.modifiedCount;
  }
  return { write, reason, wouldRestore: count, modified };
}

const toSim = (d: Document) => ({
  title: String(d.title ?? ""),
  ingredientNames: ((d.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")),
});

export async function evalSameDish(db: Db, env: Partial<OpenRouterEnv>, idsInput: unknown) {
  const ids = parseIds(idsInput, EVAL_MAX_IDS);
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) throw new RecipeWithdrawInputError("OPENROUTER_API_KEY / OPENROUTER_MODEL not set");
  const { ObjectId } = await getMongoModule();
  const col = db.collection<Document>("recipes");
  const proj = { projection: { title: 1, "ingredients.name": 1 } };
  const publicDocs = await col.find({ isPublic: true }, proj).toArray();
  const targets = await col.find({ _id: { $in: ids.map((x) => new ObjectId(x)) } }, proj).toArray();

  const results: Array<{ id: string; title: string; match: string | null; reason: string; error?: string }> = [];
  for (const t of targets) {
    const corpus = publicDocs.filter((d) => String(d._id) !== String(t._id)).map(toSim);
    try {
      const hit = await findSameDishLLM(env, toSim(t), corpus);
      results.push({ id: String(t._id), title: String(t.title ?? ""), match: hit ? hit.title : null, reason: hit ? hit.reason : "" });
    } catch (err) {
      results.push({ id: String(t._id), title: String(t.title ?? ""), match: null, reason: "", error: err instanceof SameDishCheckError ? err.message : "failed" });
    }
  }
  return { checked: results.length, matched: results.filter((r) => r.match).length, results };
}
