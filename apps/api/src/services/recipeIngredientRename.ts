/**
 * Rename single ingredient lines inside recipes — added 2026-11-08. After `pepper` became an alias of `black pepper`
 * (batch caq-2026-11-08T22-13-12-683Z), the few lines that really mean bell pepper (`peppers` counted by the piece,
 * `pepper` unit=`red`) must be renamed line-by-line: an alias cannot split them, because normalizeName() maps
 * `pepper` / `peppers` to the same key.
 *
 *   findLines — read-only: every line whose normalized name matches one of `names`, with recipeId + index.
 *   rename    — dry run unless `write`. Each edit names { recipeId, index, from, to }; the line at that index must
 *               still read `from` exactly, else the edit is refused (no guessing). Prior names are saved to
 *               `recipe_backups` under an rir-* batch. Only `ingredients.<index>.name` is written.
 *   rollback  — dry run unless `write`; restores only lines that still read what this batch wrote.
 *
 * Afterwards run POST /api/admin/recompute-costs (dry run first), or wait for the 03:00 UTC cron.
 */
import type { Db, Document } from "mongodb";
import { getMongoModule } from "../db";
import { normalizeName } from "./nameNormalizer";

export class RecipeIngredientRenameInputError extends Error {}

const HEX_RE = /^[0-9a-f]{24}$/;
const BATCH_RE = /^rir-[\w-]+$/;
const MAX_EDITS = 50;
const MAX_NAMES = 10;

function name(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 120) throw new RecipeIngredientRenameInputError(`${what} must be a non-empty name (<=120 chars)`);
  return s;
}

interface Edit {
  recipeId: string;
  index: number;
  from: string;
  to: string;
}

function parseEdits(input: unknown): Edit[] {
  if (!Array.isArray(input) || input.length === 0) throw new RecipeIngredientRenameInputError("edits must be a non-empty array");
  if (input.length > MAX_EDITS) throw new RecipeIngredientRenameInputError(`at most ${MAX_EDITS} edits per call`);
  const seen = new Set<string>();
  return input.map((e0, i) => {
    const e = e0 as Record<string, unknown> | null;
    const recipeId = String(e?.recipeId ?? "").trim().toLowerCase();
    if (!HEX_RE.test(recipeId)) throw new RecipeIngredientRenameInputError(`edits[${i}].recipeId must be ObjectId hex`);
    const index = e?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 500) {
      throw new RecipeIngredientRenameInputError(`edits[${i}].index must be an integer 0-500`);
    }
    const from = name(e?.from, `edits[${i}].from`);
    const to = name(e?.to, `edits[${i}].to`);
    if (from === to) throw new RecipeIngredientRenameInputError(`edits[${i}]: from and to are the same`);
    const key = `${recipeId}:${index}`;
    if (seen.has(key)) throw new RecipeIngredientRenameInputError(`edits[${i}]: duplicate line ${key}`);
    seen.add(key);
    return { recipeId, index, from, to };
  });
}

export async function findIngredientLines(db: Db, namesInput: unknown) {
  if (!Array.isArray(namesInput) || namesInput.length === 0) throw new RecipeIngredientRenameInputError("names must be a non-empty array");
  if (namesInput.length > MAX_NAMES) throw new RecipeIngredientRenameInputError(`at most ${MAX_NAMES} names`);
  const keys = new Set(namesInput.map((n, i) => normalizeName(name(n, `names[${i}]`))));
  const docs = await db
    .collection<Document>("recipes")
    .find({}, { projection: { title: 1, isPublic: 1, ingredients: 1 } })
    .toArray();
  const lines: Array<{ recipeId: string; title: string; isPublic: boolean; index: number; name: string; quantity: unknown; unit: unknown }> = [];
  for (const d of docs) {
    const ings = Array.isArray(d.ingredients) ? (d.ingredients as Array<Record<string, unknown>>) : [];
    ings.forEach((l, index) => {
      const n = typeof l?.name === "string" ? l.name : "";
      if (n && keys.has(normalizeName(n))) {
        lines.push({ recipeId: String(d._id), title: String(d.title ?? ""), isPublic: d.isPublic === true, index, name: n, quantity: l.quantity, unit: l.unit });
      }
    });
  }
  return { names: [...keys], count: lines.length, lines };
}

export async function renameIngredientLines(db: Db, editsInput: unknown, noteInput: unknown, write: boolean) {
  const edits = parseEdits(editsInput);
  const note = typeof noteInput === "string" ? noteInput.slice(0, 300) : null;
  const { ObjectId } = await getMongoModule();
  const col = db.collection<Document>("recipes");
  const ids = [...new Set(edits.map((e) => e.recipeId))];
  const docs = await col.find({ _id: { $in: ids.map((x) => new ObjectId(x)) } }, { projection: { title: 1, isPublic: 1, ingredients: 1 } }).toArray();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const results = edits.map((e) => {
    const d = byId.get(e.recipeId);
    if (!d) return { ...e, title: null, status: "recipe_not_found" as const };
    const line = Array.isArray(d.ingredients) ? (d.ingredients as Array<Record<string, unknown>>)[e.index] : undefined;
    const current = typeof line?.name === "string" ? line.name : null;
    const base = { ...e, title: String(d.title ?? ""), isPublic: d.isPublic === true, quantity: line?.quantity, unit: line?.unit, current };
    if (current !== e.from) return { ...base, status: "line_mismatch" as const };
    return { ...base, status: write ? ("renamed" as const) : ("would_rename" as const) };
  });
  const refused = results.filter((r) => r.status !== "would_rename" && r.status !== "renamed");

  const batch = `rir-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (write) {
    if (refused.length) {
      return { write: false, refused: "some edits do not match the live recipe — fix them first", batch: null, results, rollbackWith: null };
    }
    await db.collection("recipe_backups").insertMany(
      edits.map((e) => ({ batch, recipeId: e.recipeId, index: e.index, field: "ingredients.name", before: e.from, after: e.to, note, at: new Date() })),
    );
    for (const e of edits) {
      // Guarded: only writes if the line still reads `from` at write time.
      await col.updateOne(
        { _id: new ObjectId(e.recipeId), [`ingredients.${e.index}.name`]: e.from },
        { $set: { [`ingredients.${e.index}.name`]: e.to } },
      );
    }
  }
  return {
    write,
    batch: write ? batch : null,
    results,
    refusedCount: refused.length,
    /** POST { batch } to /recipes/ingredient-rename/rollback to undo */
    rollbackWith: write ? { batch } : null,
  };
}

export async function rollbackIngredientRename(db: Db, batchInput: unknown, write: boolean) {
  const batch = typeof batchInput === "string" ? batchInput.trim() : "";
  if (!BATCH_RE.test(batch)) throw new RecipeIngredientRenameInputError("batch must be an rir-* batch id");
  const rows = await db.collection("recipe_backups").find({ batch, field: "ingredients.name" }).toArray();
  if (!rows.length) throw new RecipeIngredientRenameInputError(`no backups for batch ${batch}`);
  const { ObjectId } = await getMongoModule();
  const col = db.collection<Document>("recipes");
  const out: Array<{ recipeId: string; index: number; restoreTo: string; status: string }> = [];
  for (const r of rows) {
    const path = `ingredients.${r.index}.name`;
    const filter = { _id: new ObjectId(String(r.recipeId)), [path]: r.after };
    const still = await col.countDocuments(filter);
    const base = { recipeId: String(r.recipeId), index: Number(r.index), restoreTo: String(r.before) };
    if (!still) {
      out.push({ ...base, status: "skipped_changed_since" });
      continue;
    }
    if (write) await col.updateOne(filter, { $set: { [path]: r.before } });
    out.push({ ...base, status: write ? "restored" : "would_restore" });
  }
  return { write, batch, rows: out };
}
