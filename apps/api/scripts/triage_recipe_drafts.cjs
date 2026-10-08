/**
 * cc_prompt_recipe_drafts_auto_triage.md Part 2 (2026-10-08) — auto-approve/auto-reject
 * pending recipe_drafts against objective rules, using the LIVE cost engine (same
 * costRecipe() the admin approve route uses on the fly), not the stale costPreview
 * field stored at draft-creation time.
 *
 * Default is --dry-run (no writes): prints + saves
 * summaries/YYYY-MM-DD_drafts-triage-dryrun.json (category counts, reject-reason
 * stats, 10 samples/category, pendingDueToImage split out separately).
 *
 * Sanity gate: if dry-run would auto-approve >600 or auto-reject >500, HALT before
 * any write and report the numbers — that ratio only happens if a rule has a bug.
 *
 * --write actually: approves via the real approveRecipeDraft() (insert recipes +
 * recipe_cost, same as POST /:id/approve) and rejects via rejectRecipeDraft() —
 * both imported from src/services/recipeDraftApproval.ts (bundled on the fly via
 * esbuild, same technique as scripts/test_recipe_draft_gap_rotation.mjs), tagging
 * every touched doc with this run's batchId so rollback_recipe_drafts_triage.cjs
 * can undo exactly this run.
 *
 * Usage:
 *   node scripts/triage_recipe_drafts.cjs              # dry run (default)
 *   node scripts/triage_recipe_drafts.cjs --write       # real writes
 *   node scripts/triage_recipe_drafts.cjs --write --limit 2   # small test batch
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");
const limitArgIdx = process.argv.indexOf("--limit");
const LIMIT = limitArgIdx !== -1 ? parseInt(process.argv[limitArgIdx + 1], 10) : null;

const API_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const SUMMARIES_DIR = path.join(REPO_ROOT, "summaries");

const SANITY_MAX_AUTO_APPROVE = 600;
const SANITY_MAX_AUTO_REJECT = 500;
const SPOONACULAR_DEAD_HOST = "img.spoonacular.com";
const FETCH_TIMEOUT_MS = 8000;

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

/** esbuild-bundles the TS services this script needs (same technique as
 * scripts/test_recipe_draft_gap_rotation.mjs) so the script and the admin route
 * share the exact same approve/reject/cost logic instead of two copies drifting apart. */
async function loadServices() {
  const { build } = require("esbuild");
  const entryFile = path.join(API_ROOT, "scripts", "_triage_entry.mjs");
  const outFile = path.join(API_ROOT, "scripts", "_triage_bundle.mjs");
  fs.writeFileSync(
    entryFile,
    [
      `export { costRecipe } from "../src/services/recipeCost.ts";`,
      `export { buildAliasIndex, resolve } from "../src/services/ingredientResolver.ts";`,
      `export { approveRecipeDraft, rejectRecipeDraft } from "../src/services/recipeDraftApproval.ts";`,
      `export { findRecipePhoto } from "../src/services/pexels.ts";`,
      `export { ingredientTextGuard, ingredientNameLooksLikeFragment } from "@uiu/shared";`,
    ].join("\n"),
  );
  try {
    await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: outFile,
      external: ["mongodb"],
      logLevel: "silent",
    });
    const mod = await import(`file://${outFile.replace(/\\/g, "/")}?t=${Date.now()}`);
    return mod;
  } finally {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** HEAD (fallback GET) must return 200 + content-type image/*. img.spoonacular.com is a
 * known-dead host (cc_prompt_recipe_drafts_auto_triage.md amendment, 2026-10-08 — cloud found
 * 12 production dead links all on this host) — rejected without even trying the fetch. */
async function imageLoads(url) {
  if (!url || typeof url !== "string") return false;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === SPOONACULAR_DEAD_HOST) return false;
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" }, FETCH_TIMEOUT_MS);
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: "GET" }, FETCH_TIMEOUT_MS);
      if (res.body && typeof res.body.cancel === "function") {
        try { await res.body.cancel(); } catch {}
      }
    }
    const ct = res.headers.get("content-type") || "";
    return res.ok && ct.toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

// Concrete bug shape from Jackie's screenshot: a key/value pair leaked into the tags array
// as one string, e.g. "mealType dinner". Strip only that exact shape, not a guess at others.
const MALFORMED_TAG_RE = /^mealType\s+/i;
function cleanTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((t) => typeof t === "string" && !MALFORMED_TAG_RE.test(t.trim()));
}

function sample(arr, n) {
  return arr.slice(0, n).map((e) => ({
    id: e.draft._id.toString(),
    title: e.draft.title,
    caloriesPerServing: e.calories,
    adjustedCoveragePct: e.cost ? Math.round(e.cost.adjustedCoveragePct * 10) / 10 : null,
    reasons: e.rejectReasons || [],
    pendingDueToImage: !!e.pendingDueToImage,
  }));
}

(async () => {
  console.log(WRITE ? `Mode: WRITE${LIMIT ? ` (--limit ${LIMIT})` : ""}` : "Mode: DRY RUN (pass --write to commit; --limit N to cap)");

  const devVars = loadDevVars();
  const env = { PEXELS_API_KEY: devVars.PEXELS_API_KEY };
  if (!env.PEXELS_API_KEY) {
    console.warn(
      "[WARN] PEXELS_API_KEY missing from apps/api/.dev.vars — the image-fallback-search step " +
        "will fail closed (treated as 'no replacement found') for every dead imageUrl, inflating " +
        "pendingDueToImage. Add it to .dev.vars before trusting these numbers.",
    );
  }

  const services = await loadServices();
  const { costRecipe, buildAliasIndex, resolve, approveRecipeDraft, rejectRecipeDraft, findRecipePhoto, ingredientNameLooksLikeFragment } = services;

  const client = new MongoClient(devVars.MONGODB_URI);
  await client.connect();
  const db = client.db(devVars.MONGODB_DB);

  try {
    const [pendingDrafts, liveRecipes] = await Promise.all([
      db.collection("recipe_drafts").find({ status: "pending" }).toArray(),
      db.collection("recipes").find({}, { projection: { title: 1 } }).toArray(),
    ]);
    console.log(`Loaded ${pendingDrafts.length} pending drafts, ${liveRecipes.length} live recipes.`);

    const ingredientsCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const allIngredientDocs = await ingredientsCol.find({}).toArray();
    const allPriceDocs = await priceCol.find({}).toArray();
    const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
    const priceMap = new Map(allPriceDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(
      allIngredientDocs.filter((d) => d.quarantine).map((d) => d.canonical_name.toLowerCase().trim()),
    );
    const aliasIndex = await buildAliasIndex(ingredientsCol);
    const resolveFn = (rawName) => resolve(rawName, aliasIndex);

    const liveTitleSet = new Set(liveRecipes.map((r) => normalizeTitle(r.title)));

    // --- Pass 1: objective reject rules + live-cost computation ---
    const evaluated = pendingDrafts.map((draft) => {
      const cost = costRecipe(draft, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      const nutrition = draft.nutrition || {};
      const calories = nutrition.calories ?? 0;
      const protein = nutrition.protein ?? 0;
      const carbs = nutrition.carbs ?? 0;
      const fat = nutrition.fat ?? 0;
      const servings = draft.servings ?? 0;
      const ingredients = Array.isArray(draft.ingredients) ? draft.ingredients : [];
      const steps = Array.isArray(draft.steps) ? draft.steps : [];

      const rejectReasons = [];
      if (calories < 50 || calories > 1500) rejectReasons.push(`calories_out_of_range:${calories}`);
      const macrosZero = protein === 0 && carbs === 0 && fat === 0;
      if ((macrosZero && calories > 0) || (calories === 0 && !macrosZero)) rejectReasons.push("macro_calorie_mismatch");
      if (steps.length < 2) rejectReasons.push(`too_few_steps:${steps.length}`);
      if (ingredients.length < 3) rejectReasons.push(`too_few_ingredients:${ingredients.length}`);
      const fragmentNames = ingredients.filter((i) => ingredientNameLooksLikeFragment(i && i.name)).map((i) => i.name);
      if (fragmentNames.length > 0) rejectReasons.push(`fragment_ingredient_name:${fragmentNames.join("|")}`);
      if (servings < 1 || servings > 12) rejectReasons.push(`servings_out_of_range:${servings}`);

      const normTitle = normalizeTitle(draft.title);
      if (liveTitleSet.has(normTitle)) rejectReasons.push("duplicate_title_live_recipe");

      return { draft, cost, calories, servings, ingredients, steps, rejectReasons, normTitle };
    });

    // --- Pass 2: intra-pending title dedup — keep highest adjustedCoveragePct, reject the rest ---
    const byNormTitle = new Map();
    for (const e of evaluated) {
      if (!byNormTitle.has(e.normTitle)) byNormTitle.set(e.normTitle, []);
      byNormTitle.get(e.normTitle).push(e);
    }
    for (const group of byNormTitle.values()) {
      if (group.length < 2) continue;
      const ranked = [...group].sort(
        (a, b) => b.cost.adjustedCoveragePct - a.cost.adjustedCoveragePct || new Date(b.draft.createdAt) - new Date(a.draft.createdAt),
      );
      for (let i = 1; i < ranked.length; i++) {
        ranked[i].rejectReasons.push(`duplicate_title_pending:kept:${ranked[0].draft._id.toString()}`);
      }
    }

    // --- Pass 3: auto-approve checks (skipped once already rejected) + image validation ---
    for (const e of evaluated) {
      if (e.rejectReasons.length > 0) {
        e.action = "auto_reject";
        continue;
      }
      const approveChecksExceptImage =
        e.cost.adjustedCoveragePct >= 80 &&
        e.calories >= 150 &&
        e.calories <= 1200 &&
        e.steps.length >= 3 &&
        e.ingredients.length >= 4 &&
        !!e.draft.mealType;

      if (!approveChecksExceptImage) {
        e.action = "pending";
        e.pendingDueToImage = false;
        continue;
      }

      let imgOk = await imageLoads(e.draft.imageUrl);
      let finalImageUrl = e.draft.imageUrl;
      if (!imgOk) {
        const fallback = await findRecipePhoto(env, e.draft.title).catch(() => null);
        if (fallback && (await imageLoads(fallback))) {
          imgOk = true;
          finalImageUrl = fallback;
        }
      }

      if (imgOk) {
        e.action = "auto_approve";
        e.finalImageUrl = finalImageUrl;
        e.cleanedTags = cleanTags(e.draft.tags);
      } else {
        e.action = "pending";
        e.pendingDueToImage = true;
      }
    }

    const approved = evaluated.filter((e) => e.action === "auto_approve");
    const rejected = evaluated.filter((e) => e.action === "auto_reject");
    const pending = evaluated.filter((e) => e.action === "pending");
    const pendingDueToImage = pending.filter((e) => e.pendingDueToImage);
    const pendingOther = pending.filter((e) => !e.pendingDueToImage);

    const rejectReasonCounts = {};
    for (const e of rejected) {
      for (const r of e.rejectReasons) {
        const key = r.split(":")[0];
        rejectReasonCounts[key] = (rejectReasonCounts[key] || 0) + 1;
      }
    }

    const dryRunReport = {
      generatedAt: new Date().toISOString(),
      totalPending: pendingDrafts.length,
      counts: {
        auto_approve: approved.length,
        auto_reject: rejected.length,
        pending: pending.length,
        pendingDueToImage: pendingDueToImage.length,
        pendingOtherReasons: pendingOther.length,
      },
      rejectReasonCounts,
      samples: {
        auto_approve: sample(approved, 10),
        auto_reject: sample(rejected, 10),
        pending: sample(pendingOther, 10),
        pendingDueToImage: sample(pendingDueToImage, 10),
      },
    };

    console.log(JSON.stringify(dryRunReport.counts, null, 2));
    console.log("Reject reason counts:", JSON.stringify(rejectReasonCounts, null, 2));

    if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dryRunPath = path.join(SUMMARIES_DIR, `${today}_drafts-triage-dryrun.json`);
    fs.writeFileSync(dryRunPath, JSON.stringify(dryRunReport, null, 2));
    console.log(`Dry-run report written: ${dryRunPath}`);

    if (approved.length > SANITY_MAX_AUTO_APPROVE || rejected.length > SANITY_MAX_AUTO_REJECT) {
      console.error(
        `[SANITY GATE] auto_approve=${approved.length} (max ${SANITY_MAX_AUTO_APPROVE}), ` +
          `auto_reject=${rejected.length} (max ${SANITY_MAX_AUTO_REJECT}) — one of these is over the ` +
          `expected range, which usually means a rule has a bug. HALTING before any write. ` +
          `Review ${dryRunPath}, fix the rule, and re-run.`,
      );
      process.exit(1);
    }

    if (!WRITE) {
      console.log("Dry run only — pass --write to commit (optionally --limit N for a small test batch).");
      return;
    }

    const batchId = `triage_${today}_${crypto.randomBytes(4).toString("hex")}`;
    console.log(`\n--write passed. batchId = ${batchId}`);

    const toApprove = LIMIT ? approved.slice(0, LIMIT) : approved;
    const toReject = LIMIT ? rejected.slice(0, Math.max(0, LIMIT - toApprove.length)) : rejected;
    console.log(`Writing: ${toApprove.length} approve, ${toReject.length} reject (limit=${LIMIT ?? "none"}).`);

    let approvedCount = 0;
    let approveFailed = 0;
    for (const e of toApprove) {
      const id = e.draft._id.toString();
      try {
        if (e.finalImageUrl && e.finalImageUrl !== e.draft.imageUrl) {
          await db.collection("recipe_drafts").updateOne({ _id: e.draft._id }, { $set: { imageUrl: e.finalImageUrl } });
        }
        if (e.cleanedTags) {
          await db.collection("recipe_drafts").updateOne({ _id: e.draft._id }, { $set: { tags: e.cleanedTags } });
        }
        const result = await approveRecipeDraft(db, env, id, { batchId, reasons: ["auto_approve: all rules passed"] });
        if ("insertedId" in result) {
          approvedCount++;
        } else {
          console.warn(`SKIP approve ${id}: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        approveFailed++;
        console.error(`FAILED approve ${id}:`, err instanceof Error ? err.message : String(err));
      }
    }

    let rejectedCount = 0;
    let rejectFailed = 0;
    for (const e of toReject) {
      const id = e.draft._id.toString();
      try {
        const result = await rejectRecipeDraft(db, id, { rejectedReason: e.rejectReasons.join("; "), triage: { batchId, reasons: e.rejectReasons } });
        if ("ok" in result) {
          rejectedCount++;
        } else {
          console.warn(`SKIP reject ${id}: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        rejectFailed++;
        console.error(`FAILED reject ${id}:`, err instanceof Error ? err.message : String(err));
      }
    }

    console.log(`\nDone. batchId=${batchId} approved=${approvedCount} (failed ${approveFailed}) rejected=${rejectedCount} (failed ${rejectFailed})`);
    console.log(`Rollback with: node scripts/rollback_recipe_drafts_triage.cjs --batch ${batchId} --write`);
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
