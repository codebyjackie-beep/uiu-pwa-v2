/**
 * Tests for services/recipeDraftOverride.ts (reopen + force-approve). No real DB — a tiny fake
 * collection covers the exact calls reopenRecipeDraft / forceApproveRecipeDraft's guards make. Run with:
 *   npx tsx apps/api/test/recipeDraftOverride.test.ts
 */
import { ObjectId } from "mongodb";
import { buildReopenEntry, forceApproveRecipeDraft, parseBy, parseNote, reopenRecipeDraft } from "../src/services/recipeDraftOverride";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

// --- pure helpers ---
eq("note required: missing", "error" in parseNote(undefined, true), true);
eq("note required: blank", "error" in parseNote("   ", true), true);
eq("note required: too short", "error" in parseNote("ok", true), true);
eq("note required: too long", "error" in parseNote("x".repeat(501), true), true);
eq("note required: non-string", "error" in parseNote({ $ne: 1 }, true), true);
eq("note required: trimmed", parseNote("  not the same dish  ", true), { note: "not the same dish" });
eq("note optional: missing ok", parseNote(undefined, false), { note: undefined });
eq("by default", parseBy(undefined), "admin");
eq("by label", parseBy("admin-ui"), "admin-ui");
eq("by injection falls back", parseBy("<script>"), "admin");

const triage = { batchId: "triage_2026-11-08_590c2960", action: "auto_reject", reasons: ["near_duplicate:same_dish:Cucumber Salad"], at: "2026-11-08T07:01:00Z" };
eq(
  "reopen entry keeps original reason + triage",
  buildReopenEntry({ rejectedReason: "near_duplicate:same_dish:Cucumber Salad", triage }, "admin", "borderline", "T"),
  { at: "T", by: "admin", note: "borderline", previousStatus: "rejected", previousRejectedReason: "near_duplicate:same_dish:Cucumber Salad", previousTriage: triage },
);
eq("reopen entry without reason", buildReopenEntry({}, "admin", undefined, "T"), { at: "T", by: "admin", previousStatus: "rejected" });

// --- fake db ---
type Doc = Record<string, any>;
function fakeDb(seed: Record<string, Doc[]>) {
  const cols: Record<string, Doc[]> = seed;
  const matches = (d: Doc, f: Doc) => Object.entries(f).every(([k, v]) => (k === "_id" ? String(d._id) === String(v) : d[k] === v));
  return {
    cols,
    collection(name: string) {
      cols[name] ??= [];
      const arr = cols[name]!;
      return {
        async findOne(f: Doc) { return arr.find((d) => matches(d, f)) ?? null; },
        async insertOne(d: Doc) { const _id = new ObjectId(); arr.push({ _id, ...d }); return { insertedId: _id }; },
        async updateOne(f: Doc, u: Doc) {
          const d = arr.find((x) => matches(x, f));
          if (!d) return { matchedCount: 0 };
          Object.assign(d, u.$set ?? {});
          for (const k of Object.keys(u.$unset ?? {})) delete d[k];
          for (const [k, v] of Object.entries(u.$push ?? {})) (d[k] ??= []).push(v);
          return { matchedCount: 1 };
        },
        find() { return { toArray: async () => arr }; },
      };
    },
  };
}

async function main() {
  const rejectedId = new ObjectId();
  const pendingId = new ObjectId();
  const db = fakeDb({
    recipe_drafts: [
      { _id: rejectedId, title: "Sunomono bowl", status: "rejected", rejectedReason: "near_duplicate:same_dish:Cucumber Salad", triage },
      { _id: pendingId, title: "Mushroom crêpe", status: "pending", ingredients: [{ name: "mushroom" }] },
    ],
    recipes: [],
  });
  const anyDb = db as any;

  // reopen dry-run: nothing written
  const dry = await reopenRecipeDraft(anyDb, rejectedId.toString(), { by: "admin", write: false });
  eq("reopen dry-run flag", (dry as any).dryRun, true);
  eq("reopen dry-run leaves status", db.cols.recipe_drafts![0]!.status, "rejected");
  eq("reopen dry-run no audit", db.cols.recipe_draft_audit?.length ?? 0, 0);

  // reopen write
  const wet = await reopenRecipeDraft(anyDb, rejectedId.toString(), { by: "admin", note: "borderline", write: true });
  const d0 = db.cols.recipe_drafts![0]!;
  eq("reopen write → pending", d0.status, "pending");
  eq("reopen write unsets triage (rollback won't touch it)", "triage" in d0, false);
  eq("reopen write unsets rejectedReason", "rejectedReason" in d0, false);
  eq("reopen history kept reason", d0.reopenHistory?.[0]?.previousRejectedReason, "near_duplicate:same_dish:Cucumber Salad");
  eq("reopen history kept batch", d0.reopenHistory?.[0]?.previousTriage?.batchId, "triage_2026-11-08_590c2960");
  eq("reopen audit written", db.cols.recipe_draft_audit?.[0]?.action, "reopen");
  eq("reopen result has auditId", typeof (wet as any).auditId, "string");

  // reopen again → wrong status
  eq("reopen pending → conflict", await reopenRecipeDraft(anyDb, rejectedId.toString(), { by: "admin", write: true }), { wrongStatus: "pending" });
  eq("reopen missing → notFound", await reopenRecipeDraft(anyDb, new ObjectId().toString(), { by: "admin", write: false }), { notFound: true });

  // force-approve dry-run: no OpenRouter key → same-dish returns null, nothing written
  const fdry = await forceApproveRecipeDraft(anyDb, {} as any, pendingId.toString(), { by: "admin", note: "not the same dish", write: false });
  eq("force dry-run flag", (fdry as any).dryRun, true);
  eq("force dry-run reports checks", (fdry as any).skippedChecks, { nearDuplicate: null, sameDish: null });
  eq("force dry-run no recipe", db.cols.recipes!.length, 0);
  eq("force dry-run leaves status", db.cols.recipe_drafts![1]!.status, "pending");

  // force-approve on a rejected draft → conflict (reopen first)
  db.cols.recipe_drafts![1]!.status = "rejected";
  eq("force on rejected → conflict", await forceApproveRecipeDraft(anyDb, {} as any, pendingId.toString(), { by: "admin", note: "not the same dish", write: true }), { wrongStatus: "rejected" });

  if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("recipeDraftOverride: all checks passed");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
