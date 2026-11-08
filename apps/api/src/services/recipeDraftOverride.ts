/**
 * Admin overrides for recipe_drafts triage (2026-11-08):
 *   reopen        rejected → pending, keeps who/when/original reject reason in `reopenHistory`
 *   force-approve pending → approved, SKIPS the near-duplicate + AI same-dish checks; note required
 *
 * Why: approveRecipeDraft() only accepts "pending" and re-runs the same-dish check, so a draft the
 * auto-triage cron rejected as same_dish (e.g. a borderline call Jackie disagrees with) could never be
 * approved. Both actions are dry-run unless write=true, and every write adds one `recipe_draft_audit` doc.
 *
 * Reopen moves `triage` + `rejectedReason` into `reopenHistory` and unsets them, so a later
 * rollbackTriageBatch() of the original batch no longer touches this draft (it would otherwise flip
 * a force-approved draft back to "pending" while its recipe stays live).
 */
import type { Db, Document } from "mongodb";
import { findNearDuplicateRecipe, type NearDuplicateMatch } from "@uiu/shared";
import { getMongoModule } from "../db";
import { approveRecipeDraft } from "./recipeDraftApproval";
import { findSameDishLLM } from "./sameDish";
import type { PexelsEnv } from "./pexels";
import type { OpenRouterEnv } from "./openrouter";

export const AUDIT_COLLECTION = "recipe_draft_audit";
export const NOTE_MIN = 5;
export const NOTE_MAX = 500;

/** Trimmed note, or an error message. Force-approve requires one; reopen accepts an optional one. */
export function parseNote(raw: unknown, required: boolean): { note: string | undefined } | { error: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return required ? { error: `note is required (${NOTE_MIN}-${NOTE_MAX} chars) — say why this is not the same dish` } : { note: undefined };
  }
  if (typeof raw !== "string") return { error: "note must be a string" };
  const note = raw.trim();
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) return { error: `note must be ${NOTE_MIN}-${NOTE_MAX} chars` };
  return { note };
}

/** Who did it. No per-user identity behind X-Admin-Token, so this is a free label (default "admin"). */
export function parseBy(raw: unknown): string {
  if (typeof raw !== "string") return "admin";
  const by = raw.trim();
  return /^[\w .@-]{1,40}$/.test(by) ? by : "admin";
}

export interface ReopenHistoryEntry {
  at: string;
  by: string;
  note?: string;
  previousStatus: "rejected";
  previousRejectedReason?: string;
  previousTriage?: unknown;
}

/** Pure: the history entry a reopen appends. */
export function buildReopenEntry(draft: Document, by: string, note: string | undefined, at: string): ReopenHistoryEntry {
  return {
    at,
    by,
    ...(note ? { note } : {}),
    previousStatus: "rejected",
    ...(typeof draft.rejectedReason === "string" ? { previousRejectedReason: draft.rejectedReason } : {}),
    ...(draft.triage ? { previousTriage: draft.triage } : {}),
  };
}

export type OverrideResult<T> =
  | { notFound: true }
  | { wrongStatus: string }
  | T;

export interface ReopenResult {
  dryRun: boolean;
  id: string;
  title: string;
  from: "rejected";
  to: "pending";
  entry: ReopenHistoryEntry;
  auditId?: string;
}

export async function reopenRecipeDraft(
  db: Db,
  draftId: string,
  opts: { by: string; note?: string; write: boolean },
): Promise<OverrideResult<ReopenResult>> {
  const { ObjectId } = await getMongoModule();
  const _id = new ObjectId(draftId);
  const draft = await db.collection("recipe_drafts").findOne({ _id });
  if (!draft) return { notFound: true };
  if (draft.status !== "rejected") return { wrongStatus: String(draft.status) };

  const at = new Date().toISOString();
  const entry = buildReopenEntry(draft, opts.by, opts.note, at);
  const base: ReopenResult = { dryRun: !opts.write, id: draftId, title: String(draft.title ?? ""), from: "rejected", to: "pending", entry };
  if (!opts.write) return base;

  // Atomic on status so two reopen clicks (or a concurrent rollback) can't double-process.
  const res = await db.collection("recipe_drafts").updateOne(
    { _id, status: "rejected" },
    { $set: { status: "pending" }, $unset: { triage: "", rejectedReason: "" }, $push: { reopenHistory: entry } } as unknown as Document,
  );
  if (res.matchedCount === 0) return { wrongStatus: "changed_concurrently" };
  const audit = await db.collection(AUDIT_COLLECTION).insertOne({ action: "reopen", draftId, title: base.title, ...entry });
  return { ...base, auditId: audit.insertedId.toString() };
}

export interface ForceApproveResult {
  dryRun: boolean;
  id: string;
  title: string;
  by: string;
  note: string;
  /** What the skipped checks say right now (dry-run only, informational). null = check found nothing. */
  skippedChecks?: { nearDuplicate: NearDuplicateMatch | null; sameDish: (NearDuplicateMatch & { reason?: string }) | null | "check_failed" };
  recipeId?: string;
  auditId?: string;
}

export async function forceApproveRecipeDraft(
  db: Db,
  env: PexelsEnv & Partial<OpenRouterEnv>,
  draftId: string,
  opts: { by: string; note: string; write: boolean },
): Promise<OverrideResult<ForceApproveResult>> {
  const { ObjectId } = await getMongoModule();
  const draft = await db.collection("recipe_drafts").findOne({ _id: new ObjectId(draftId) });
  if (!draft) return { notFound: true };
  if (draft.status !== "pending") return { wrongStatus: String(draft.status) };
  const title = String(draft.title ?? "");
  const base: ForceApproveResult = { dryRun: !opts.write, id: draftId, title, by: opts.by, note: opts.note };

  if (!opts.write) {
    const publicRecipes = await db.collection("recipes").find({ isPublic: true }, { projection: { title: 1, "ingredients.name": 1 } }).toArray();
    const candidate = { title, ingredientNames: ((draft.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")) };
    const corpus = publicRecipes.map((r) => ({ title: String(r.title ?? ""), ingredientNames: ((r.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")) }));
    const nearDuplicate = findNearDuplicateRecipe(candidate, corpus);
    const sameDish = await findSameDishLLM(env, candidate, corpus).catch(() => "check_failed" as const);
    return { ...base, skippedChecks: { nearDuplicate, sameDish } };
  }

  const at = new Date().toISOString();
  const r = await approveRecipeDraft(db, env, draftId, undefined, { by: opts.by, note: opts.note, at });
  if ("notFound" in r) return { notFound: true };
  if ("alreadyDecided" in r) return { wrongStatus: "changed_concurrently" };
  if ("nearDuplicate" in r) throw new Error("force-approve unexpectedly ran the duplicate check");
  const audit = await db.collection(AUDIT_COLLECTION).insertOne({
    action: "force_approve",
    draftId,
    title,
    by: opts.by,
    note: opts.note,
    at,
    recipeId: r.insertedId,
    skipped: ["near_duplicate", "same_dish"],
  });
  return { ...base, recipeId: r.insertedId, auditId: audit.insertedId.toString() };
}
