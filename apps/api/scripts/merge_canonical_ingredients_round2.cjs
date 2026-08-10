// HANDOFF_canonical-ingredients-curation-round2-merge.md — 6-group alias merge.
//
// Step 0 finding (see summary md): alias resolution is DYNAMIC at read time
// (buildAliasIndex() scans canonical_ingredients.aliases[] fresh on every
// precompute run — see assets/canonical_resolver.service.js /
// apps/api/src/services/ingredientResolver.ts), but `recipe_cost.lines[]` is
// a FROZEN, precomputed cache (apps/api/src/jobs/precomputeRecipeCosts.ts,
// upserted by a cron job) — editing canonical_ingredients alone does NOT
// change any existing recipe_cost doc. A merge therefore has two effects that
// must both be simulated here: (a) canonical_ingredients doc changes
// (aliases[] / density_cup / quarantine), and (b) the resulting recipe_cost
// recompute delta once precomputeRecipeCosts is next run.
//
// Also confirms the prior "source":"merge" docs (jalapeno pepper / spring
// onion, updated_at 2026-07-19) were NOT a completed merge: both duplicate
// docs are still live, non-quarantined, with non-overlapping alias lists —
// i.e. some past process tagged them source:"merge" (likely while
// consolidating nutrition data) but never actually merged the alias lists or
// quarantined the loser. This script completes that for real.
//
// Default: dry run — computes and reports the full before/after delta,
// writes nothing. Pass --write to commit (not done in this session — Jackie
// reviews the dry-run report first).
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const { normalizeName } = require("../../../../assets/name_normalizer.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

const WRITE = process.argv.includes("--write");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
  const content = fs.readFileSync(p, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// The 6 merge groups from the handoff.
const MERGES = [
  {
    loser: "evoo",
    survivor: "olive oil",
    addAliases: ["evoo", "EVOO"],
    fieldFixes: { density_cup: 216 },
    fieldFixSource: "USDA (via nutritionvalue.org): 1 cup olive oil = 216.0 g",
    quarantineReason: "merged_into:olive oil",
  },
  {
    loser: "sucre",
    survivor: "sugar",
    addAliases: ["sucre"],
    fieldFixes: {},
    quarantineReason: "merged_into:sugar",
  },
  {
    loser: "jalapeño",
    survivor: "jalapeno pepper",
    addAliases: ["jalapeño", "jalapeños"],
    fieldFixes: { density_cup: 90 },
    fieldFixSource:
      "USDA fdcId 168576 (via myfooddata.com + nutritionvalue.org, two independent sources): 1 cup sliced jalapeno = 90.0 g (was 150 — pre-existing error, same class as Round 1 cherry tomato)",
    quarantineReason: "merged_into:jalapeno pepper",
  },
  {
    loser: "fresh coriander, chopped",
    survivor: "coriander leaves",
    addAliases: ["fresh coriander, chopped", "Fresh Coriander, chopped"],
    fieldFixes: {},
    quarantineReason: "merged_into:coriander leaves",
  },
  {
    loser: "spring onion 5%",
    survivor: "spring onion",
    addAliases: ["spring onion 5%"],
    fieldFixes: {},
    quarantineReason: "merged_into:spring onion",
  },
];

// #6: quarantine only, no survivor — flagged Round 1 parsing artifact.
const QUARANTINE_ONLY = [{ name: "each", quarantineReason: "parsing_artifact:not_an_ingredient" }];

function buildAliasIndexFromDocs(docs) {
  function isBetterMatch(candidate, current) {
    const candidateComplete = candidate.density_cup != null || candidate.per_item_g != null;
    const currentComplete = current.density_cup != null || current.per_item_g != null;
    if (candidateComplete !== currentComplete) return candidateComplete;
    return (candidate.recipe_count || 0) > (current.recipe_count || 0);
  }
  const winners = new Map();
  for (const doc of docs) {
    if (doc.quarantine === true) continue;
    for (const key of new Set([doc.canonical_name, ...(doc.aliases || [])])) {
      const normalized = normalizeName(key);
      if (!normalized) continue;
      const current = winners.get(normalized);
      if (!current || isBetterMatch(doc, current)) winners.set(normalized, doc);
    }
  }
  const index = new Map();
  for (const [normalized, doc] of winners) index.set(normalized, doc.canonical_name);
  return index;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
function resolveWithIndex(rawName, index) {
  const normalized = normalizeName(rawName);
  if (!normalized) return { unresolved: true };
  const exact = index.get(normalized);
  if (exact) return { canonical_name: exact, method: "exact" };
  if (normalized.length < 4) return { unresolved: true };
  let best = null, bestDist = Infinity;
  for (const key of index.keys()) {
    if (Math.abs(key.length - normalized.length) > 1) continue;
    const dist = levenshtein(normalized, key);
    if (dist < bestDist) { bestDist = dist; best = key; if (dist === 0) break; }
  }
  if (best && bestDist <= 1) return { canonical_name: index.get(best), method: "fuzzy", confidence: "low" };
  return { unresolved: true };
}

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ciCol = db.collection("canonical_ingredients");
    const priceCol = db.collection("canonical_price_cache");
    const recipesCol = db.collection("recipes");

    const allIngredientDocsRaw = await ciCol.find({}).toArray();
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));
    const allRecipes = await recipesCol.find({}).toArray();

    // ---- OLD state (live production, unchanged) ----
    const oldDocs = allIngredientDocsRaw.map((d) => ({ ...d }));
    const oldIndex = buildAliasIndexFromDocs(oldDocs);
    const oldResolveFn = (raw) => resolveWithIndex(raw, oldIndex);
    const oldIngredientsMap = new Map(oldDocs.map((d) => [d.canonical_name, d]));
    const oldQuarantinedNames = new Set(
      oldDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()),
    );

    // ---- NEW state (simulated merge applied in-memory) ----
    const byName = new Map(allIngredientDocsRaw.map((d) => [d.canonical_name, { ...d }]));
    const docChanges = [];

    for (const m of MERGES) {
      const survivor = byName.get(m.survivor);
      const loser = byName.get(m.loser);
      if (!survivor || !loser) throw new Error(`Missing doc for merge: ${m.loser} -> ${m.survivor}`);

      const beforeAliases = [...(survivor.aliases || [])];
      const newAliasSet = new Set([...(survivor.aliases || []), ...m.addAliases]);
      survivor.aliases = [...newAliasSet];

      const beforeFields = {};
      const afterFields = {};
      for (const [k, v] of Object.entries(m.fieldFixes)) {
        beforeFields[k] = survivor[k] ?? null;
        survivor[k] = v;
        afterFields[k] = v;
      }

      loser.quarantine = true;
      loser.quarantined_at = new Date().toISOString();
      loser.quarantined_reason = m.quarantineReason;

      docChanges.push({
        group: `${m.loser} -> ${m.survivor}`,
        survivor: {
          canonical_name: m.survivor,
          aliases_before: beforeAliases,
          aliases_after: survivor.aliases,
          field_fixes: Object.keys(m.fieldFixes).length ? { before: beforeFields, after: afterFields, source: m.fieldFixSource } : null,
        },
        loser: {
          canonical_name: m.loser,
          quarantined_reason: m.quarantineReason,
        },
      });
    }

    for (const q of QUARANTINE_ONLY) {
      const doc = byName.get(q.name);
      if (!doc) throw new Error(`Missing doc to quarantine: ${q.name}`);
      doc.quarantine = true;
      doc.quarantined_at = new Date().toISOString();
      doc.quarantined_reason = q.quarantineReason;
      docChanges.push({
        group: `${q.name} -> quarantine (no merge target)`,
        survivor: null,
        loser: { canonical_name: q.name, quarantined_reason: q.quarantineReason },
      });
    }

    const newDocs = [...byName.values()];
    const newIndex = buildAliasIndexFromDocs(newDocs);
    const newResolveFn = (raw) => resolveWithIndex(raw, newIndex);
    const newIngredientsMap = new Map(newDocs.map((d) => [d.canonical_name, d]));
    const newQuarantinedNames = new Set(
      newDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()),
    );

    // ---- Recompute recipe_cost (old vs new) across ALL recipes, report line-level diffs ----
    let oldAt = 0, oldAp = 0, newAt = 0, newAp = 0;
    let oldPubAt = 0, oldPubAp = 0, newPubAt = 0, newPubAp = 0;
    const lineDiffs = [];

    for (const r of allRecipes) {
      const oldCost = costRecipe(r, oldResolveFn, oldIngredientsMap, priceMap, oldQuarantinedNames);
      const newCost = costRecipe(r, newResolveFn, newIngredientsMap, priceMap, newQuarantinedNames);

      oldAt += oldCost.adjustedTotal; oldAp += oldCost.adjustedPriceable;
      newAt += newCost.adjustedTotal; newAp += newCost.adjustedPriceable;
      if (r.isPublic) {
        oldPubAt += oldCost.adjustedTotal; oldPubAp += oldCost.adjustedPriceable;
        newPubAt += newCost.adjustedTotal; newPubAp += newCost.adjustedPriceable;
      }

      for (let i = 0; i < oldCost.lines.length; i += 1) {
        const a = oldCost.lines[i];
        const b = newCost.lines[i];
        if (a.canonical_name !== b.canonical_name || a.priceable !== b.priceable || a.reason !== b.reason) {
          lineDiffs.push({
            recipeId: String(r._id),
            title: r.title,
            isPublic: !!r.isPublic,
            rawName: a.rawName,
            before: { canonical_name: a.canonical_name || null, priceable: a.priceable, reason: a.reason || null, lineCost: a.lineCost ?? null },
            after: { canonical_name: b.canonical_name || null, priceable: b.priceable, reason: b.reason || null, lineCost: b.lineCost ?? null },
          });
        }
      }
    }

    const report = {
      mode: WRITE ? "write" : "dry-run",
      generatedAt: new Date().toISOString(),
      docChanges,
      recipeCostImpact: {
        note: "Simulated using in-memory old/new canonical_ingredients state against the SAME frozen recipe.ingredients[] — this previews what re-running precomputeRecipeCosts would change. It does not write to recipe_cost.",
        allRecipes: {
          before: { adjustedTotal: oldAt, adjustedPriceable: oldAp, adjustedCoveragePct: oldAt ? (oldAp / oldAt) * 100 : 0 },
          after: { adjustedTotal: newAt, adjustedPriceable: newAp, adjustedCoveragePct: newAt ? (newAp / newAt) * 100 : 0 },
        },
        publicOnly: {
          before: { adjustedTotal: oldPubAt, adjustedPriceable: oldPubAp, adjustedCoveragePct: oldPubAt ? (oldPubAp / oldPubAt) * 100 : 0 },
          after: { adjustedTotal: newPubAt, adjustedPriceable: newPubAp, adjustedCoveragePct: newPubAt ? (newPubAp / newPubAt) * 100 : 0 },
        },
        lineDiffCount: lineDiffs.length,
        lineDiffs,
      },
    };

    if (WRITE) {
      for (const m of MERGES) {
        const survivorDoc = byName.get(m.survivor);
        const loserDoc = byName.get(m.loser);
        const survivorSet = { aliases: survivorDoc.aliases, ...m.fieldFixes };
        await ciCol.updateOne({ canonical_name: m.survivor }, { $set: survivorSet });
        await ciCol.updateOne(
          { canonical_name: m.loser },
          { $set: { quarantine: true, quarantined_at: loserDoc.quarantined_at, quarantined_reason: loserDoc.quarantined_reason } },
        );
      }
      for (const q of QUARANTINE_ONLY) {
        const doc = byName.get(q.name);
        await ciCol.updateOne(
          { canonical_name: q.name },
          { $set: { quarantine: true, quarantined_at: doc.quarantined_at, quarantined_reason: doc.quarantined_reason } },
        );
      }
      console.log("WRITE complete — canonical_ingredients updated. recipe_cost NOT recomputed by this script; re-run precomputeRecipeCosts / tools/parity_replay.js next.");
    } else {
      console.log("DRY RUN — no DB writes performed. Pass --write to commit.");
    }

    const reportPath = path.resolve(
      __dirname,
      "../../../../summaries",
      `2026-08-10_curation_round2_merge_${WRITE ? "write" : "dry-run"}.json`,
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${reportPath}`);
    console.log(`\ndocChanges: ${docChanges.length}`);
    console.log(`lineDiffCount: ${lineDiffs.length}`);
    console.log("allRecipes before:", report.recipeCostImpact.allRecipes.before);
    console.log("allRecipes after: ", report.recipeCostImpact.allRecipes.after);
    console.log("publicOnly before:", report.recipeCostImpact.publicOnly.before);
    console.log("publicOnly after: ", report.recipeCostImpact.publicOnly.after);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
