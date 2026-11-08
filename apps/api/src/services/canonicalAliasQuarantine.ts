/**
 * Add aliases to canonical_ingredients docs and/or quarantine docs over HTTPS — added 2026-11-08 to retire the
 * `tomatoe` (typo) and `pepper` (black vs bell ambiguity) canonicals: their raw names move to the right canonical as
 * aliases and the old docs are quarantined (never deleted — buildAliasIndex() skips quarantine:true, so they stop matching).
 *
 *   apply    — dry run unless `write`. Dry run simulates the alias index after the change and reports, for every alias,
 *              which canonical it would resolve to (and any conflict with another live doc). Write is refused while any
 *              conflict exists. Prior `aliases` / `quarantine` of every touched doc are saved to `canonical_backups`.
 *   rollback — dry run unless `write`; restores the saved fields only if the doc still holds what this batch wrote.
 *
 * Does not touch price_refresh_overrides (use /price-refresh/overrides/remove) or prices. After a write run
 * POST /api/admin/recompute-costs (dry run first), or wait for the 03:00 UTC cron.
 */
import type { Db, Document } from "mongodb";
import { normalizeName } from "./nameNormalizer";

const BATCH_RE = /^caq-[\w-]+$/;
const MAX_ITEMS = 20;

export class CanonicalAliasInputError extends Error {}

export interface AliasQuarantineInput {
  /** [{ alias: "pepper", to: "black pepper" }] — alias is added verbatim to `to`'s aliases[] */
  addAliases?: unknown;
  /** ["pepper"] — canonical names to set quarantine:true */
  quarantine?: unknown;
  note?: unknown;
}

interface CanonDoc {
  canonical_name: string;
  aliases?: string[];
  quarantine?: boolean;
  density_cup?: number | null;
  per_item_g?: number | null;
  recipe_count?: number;
}

function str(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 120 || s.startsWith("__")) throw new CanonicalAliasInputError(`${what} must be a non-empty name (<=120 chars)`);
  return s;
}

function parse(body: AliasQuarantineInput | null) {
  const rawAdd = body?.addAliases ?? [];
  const rawQ = body?.quarantine ?? [];
  if (!Array.isArray(rawAdd) || !Array.isArray(rawQ)) throw new CanonicalAliasInputError("addAliases and quarantine must be arrays");
  if (!rawAdd.length && !rawQ.length) throw new CanonicalAliasInputError("nothing to do");
  if (rawAdd.length > MAX_ITEMS || rawQ.length > MAX_ITEMS) throw new CanonicalAliasInputError(`max ${MAX_ITEMS} items each`);
  const addAliases = rawAdd.map((a, i) => {
    const o = a as { alias?: unknown; to?: unknown } | null;
    return { alias: str(o?.alias, `addAliases[${i}].alias`), to: str(o?.to, `addAliases[${i}].to`) };
  });
  const quarantine = [...new Set(rawQ.map((q, i) => str(q, `quarantine[${i}]`)))];
  for (const a of addAliases) {
    if (quarantine.includes(a.to)) throw new CanonicalAliasInputError(`cannot add an alias to "${a.to}" and quarantine it`);
  }
  const note = typeof body?.note === "string" ? body.note.slice(0, 300) : null;
  return { addAliases, quarantine, note };
}

// Same tie-break as ingredientResolver.isBetterMatch — keep in sync.
function isBetter(a: CanonDoc, b: CanonDoc): boolean {
  const ac = a.density_cup != null || a.per_item_g != null;
  const bc = b.density_cup != null || b.per_item_g != null;
  if (ac !== bc) return ac;
  return (a.recipe_count || 0) > (b.recipe_count || 0);
}

export async function applyAliasQuarantine(db: Db, body: AliasQuarantineInput | null, write: boolean) {
  const { addAliases, quarantine, note } = parse(body);
  const col = db.collection<Document>("canonical_ingredients");
  const all = (await col
    .find({})
    .project({ canonical_name: 1, aliases: 1, quarantine: 1, density_cup: 1, per_item_g: 1, recipe_count: 1 })
    .toArray()) as unknown as CanonDoc[];
  const byName = new Map(all.map((d) => [d.canonical_name, d]));

  const touched = new Set([...addAliases.map((a) => a.to), ...quarantine]);
  for (const name of touched) {
    if (!byName.has(name)) throw new CanonicalAliasInputError(`no canonical_ingredients doc named "${name}"`);
  }
  for (const a of addAliases) {
    if (byName.get(a.to)!.quarantine === true) throw new CanonicalAliasInputError(`"${a.to}" is quarantined — pick a live canonical`);
  }

  // Build the after-state in memory.
  const after = new Map<string, { aliases: string[]; quarantine: boolean }>();
  for (const name of touched) {
    const d = byName.get(name)!;
    after.set(name, { aliases: [...(d.aliases ?? [])], quarantine: d.quarantine === true });
  }
  const aliasesAdded: Array<{ alias: string; to: string; alreadyThere: boolean }> = [];
  for (const a of addAliases) {
    const st = after.get(a.to)!;
    const there = st.aliases.includes(a.alias);
    if (!there) st.aliases.push(a.alias);
    aliasesAdded.push({ ...a, alreadyThere: there });
  }
  for (const q of quarantine) after.get(q)!.quarantine = true;

  // Simulate buildAliasIndex() on the after-state.
  const winners = new Map<string, CanonDoc>();
  const claimants = new Map<string, Set<string>>();
  for (const d0 of all) {
    const st = after.get(d0.canonical_name);
    const d: CanonDoc = st ? { ...d0, aliases: st.aliases, quarantine: st.quarantine } : d0;
    if (d.quarantine === true) continue;
    for (const key of new Set([d.canonical_name, ...(d.aliases ?? [])])) {
      const k = normalizeName(key);
      if (!k) continue;
      if (!claimants.has(k)) claimants.set(k, new Set());
      claimants.get(k)!.add(d.canonical_name);
      const cur = winners.get(k);
      if (!cur || isBetter(d, cur)) winners.set(k, d);
    }
  }
  const checks = addAliases.map((a) => {
    const k = normalizeName(a.alias);
    const resolvesTo = winners.get(k)?.canonical_name ?? null;
    const others = [...(claimants.get(k) ?? [])].filter((n) => n !== a.to);
    return { alias: a.alias, normalized: k, to: a.to, resolvesTo, ok: resolvesTo === a.to, otherClaimants: others };
  });
  const conflicts = checks.filter((c) => !c.ok);

  const changes = [...touched].map((name) => {
    const d = byName.get(name)!;
    return {
      canonical_name: name,
      before: { aliases: d.aliases ?? [], quarantine: d.quarantine === true },
      after: after.get(name)!,
    };
  });

  const batch = `caq-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let written = false;
  if (write) {
    if (conflicts.length) {
      return { write: false, refused: "alias conflicts — fix them first", batch: null, changes, checks, conflicts, rollbackWith: null };
    }
    await db.collection("canonical_backups").insertMany(
      changes.map((c) => ({ batch, canonical_name: c.canonical_name, field: "aliases+quarantine", before: c.before, after: c.after, note, at: new Date() })),
    );
    for (const c of changes) {
      // Only ever sets quarantine:true (never writes quarantine:false onto docs that had no field).
      const set: Document = { aliases: c.after.aliases };
      if (c.after.quarantine && !c.before.quarantine) set.quarantine = true;
      await col.updateOne({ canonical_name: c.canonical_name }, { $set: set });
    }
    written = true;
  }
  return {
    write: written,
    batch: written ? batch : null,
    changes,
    aliasesAdded,
    checks,
    conflicts,
    /** POST { batch } to /canonical/alias-quarantine/rollback to undo */
    rollbackWith: written ? { batch } : null,
  };
}

function sameState(cur: Document | null, want: { aliases: string[]; quarantine: boolean }): boolean {
  if (!cur) return false;
  const a = (cur.aliases as string[] | undefined) ?? [];
  return (cur.quarantine === true) === want.quarantine && a.length === want.aliases.length && a.every((x, i) => x === want.aliases[i]);
}

export async function rollbackAliasQuarantine(db: Db, batchInput: unknown, write: boolean) {
  const batch = typeof batchInput === "string" ? batchInput.trim() : "";
  if (!BATCH_RE.test(batch)) throw new CanonicalAliasInputError("batch must be a caq-* batch id");
  const rows = await db.collection("canonical_backups").find({ batch, field: "aliases+quarantine" }).toArray();
  if (!rows.length) throw new CanonicalAliasInputError(`no backups for batch ${batch}`);
  const col = db.collection<Document>("canonical_ingredients");
  const out: Array<{ canonical_name: string; restoreTo: unknown; status: string }> = [];
  for (const r of rows) {
    const cur = await col.findOne({ canonical_name: r.canonical_name }, { projection: { aliases: 1, quarantine: 1 } });
    const before = r.before as { aliases: string[]; quarantine: boolean };
    if (!sameState(cur, r.after as { aliases: string[]; quarantine: boolean })) {
      out.push({ canonical_name: String(r.canonical_name), restoreTo: before, status: "skipped_changed_since" });
      continue;
    }
    if (write) {
      const set: Document = { aliases: before.aliases };
      const update: Document = before.quarantine ? { $set: { ...set, quarantine: true } } : { $set: set, $unset: { quarantine: "" } };
      await col.updateOne({ canonical_name: r.canonical_name }, update);
    }
    out.push({ canonical_name: String(r.canonical_name), restoreTo: before, status: write ? "restored" : "would_restore" });
  }
  return { write, batch, rows: out };
}
