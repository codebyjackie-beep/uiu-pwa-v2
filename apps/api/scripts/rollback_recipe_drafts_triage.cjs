/**
 * cc_prompt_recipe_drafts_auto_triage.md Part 2 (2026-10-08) — undo one
 * triage_recipe_drafts.cjs --write run, identified by its batchId.
 *
 * Deletes every `recipes` doc with autoApprovedBatchId === batchId (+ its
 * matching `recipe_cost` doc by recipeId), and reverts every `recipe_drafts`
 * doc with triage.batchId === batchId back to status:"pending" (clearing
 * triage/rejectedReason).
 *
 * Default is --dry-run (prints counts, writes nothing). Pass --write to
 * actually perform the rollback. Per cc_prompt_recipe_drafts_auto_triage.md's
 * verification rule, this script must be proven against a small (2-draft)
 * test batch only — never run at full scale without Jackie's explicit say.
 *
 * Usage:
 *   node scripts/rollback_recipe_drafts_triage.cjs --batch <batchId>            # dry run
 *   node scripts/rollback_recipe_drafts_triage.cjs --batch <batchId> --write    # real rollback
 */
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const API_ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const batchArgIdx = process.argv.indexOf("--batch");
const BATCH_ID = batchArgIdx !== -1 ? process.argv[batchArgIdx + 1] : null;

if (!BATCH_ID) {
  console.error("Usage: node scripts/rollback_recipe_drafts_triage.cjs --batch <batchId> [--write]");
  process.exit(1);
}

function loadDevVars() {
  const p = path.resolve(API_ROOT, ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, idx)] = value;
  }
  return env;
}

(async () => {
  console.log(`Rolling back batchId=${BATCH_ID} — mode: ${WRITE ? "WRITE" : "DRY RUN (pass --write to commit)"}`);

  const devVars = loadDevVars();
  const client = new MongoClient(devVars.MONGODB_URI);
  await client.connect();
  const db = client.db(devVars.MONGODB_DB);

  try {
    const recipesToDelete = await db.collection("recipes").find({ autoApprovedBatchId: BATCH_ID }).toArray();
    const draftsToRevert = await db.collection("recipe_drafts").find({ "triage.batchId": BATCH_ID }).toArray();
    const recipeIds = recipesToDelete.map((r) => r._id.toString());
    // recipe_cost.recipeId was historically stored as a raw ObjectId by a bug in
    // approveRecipeDraft() (fixed 2026-10-08) instead of the string the RecipeCost
    // type declares — match both shapes so this works on docs written before and
    // after that fix (every doc created by today's real triage batch is still the
    // old ObjectId shape).
    const recipeObjectIds = recipesToDelete.map((r) => r._id);
    const costsToDelete = recipeIds.length
      ? await db.collection("recipe_cost").find({ recipeId: { $in: [...recipeIds, ...recipeObjectIds] } }).toArray()
      : [];

    const approvedDrafts = draftsToRevert.filter((d) => d.triage?.action === "auto_approve");
    const rejectedDrafts = draftsToRevert.filter((d) => d.triage?.action === "auto_reject");

    console.log(`Found: ${recipesToDelete.length} recipes, ${costsToDelete.length} recipe_cost docs, ` +
      `${draftsToRevert.length} drafts to revert (${approvedDrafts.length} were auto_approve, ${rejectedDrafts.length} were auto_reject).`);

    if (recipesToDelete.length !== approvedDrafts.length) {
      console.warn(
        `[WARN] recipes-to-delete (${recipesToDelete.length}) != approved-drafts-to-revert (${approvedDrafts.length}) — ` +
          `investigate before writing (could mean a recipe was edited/orphaned since triage, or a draft's triage tag was cleared separately).`,
      );
    }

    if (!WRITE) {
      console.log("Dry run only — pass --write to actually delete/revert the above.");
      console.log("Recipe ids:", recipeIds);
      console.log("Draft ids:", draftsToRevert.map((d) => d._id.toString()));
      return;
    }

    const deleteRecipesResult = recipeIds.length
      ? await db.collection("recipes").deleteMany({ autoApprovedBatchId: BATCH_ID })
      : { deletedCount: 0 };
    const deleteCostsResult = recipeIds.length
      ? await db.collection("recipe_cost").deleteMany({ recipeId: { $in: [...recipeIds, ...recipeObjectIds] } })
      : { deletedCount: 0 };
    const revertResult = await db.collection("recipe_drafts").updateMany(
      { "triage.batchId": BATCH_ID },
      { $set: { status: "pending" }, $unset: { triage: "", rejectedReason: "" } },
    );

    console.log(
      `Done. Deleted ${deleteRecipesResult.deletedCount} recipes, ${deleteCostsResult.deletedCount} recipe_cost docs. ` +
        `Reverted ${revertResult.modifiedCount} drafts to pending.`,
    );

    const remainingRecipes = await db.collection("recipes").countDocuments({ autoApprovedBatchId: BATCH_ID });
    const remainingDrafts = await db.collection("recipe_drafts").countDocuments({ "triage.batchId": BATCH_ID });
    console.log(`Post-rollback check: ${remainingRecipes} recipes still tagged with this batch (expect 0), ${remainingDrafts} drafts still tagged (expect 0).`);
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
