// HANDOFF_resolver-fuzzy-match-audit.md — read-only audit, no production
// writes. Reuses assets/canonical_resolver.service.js buildAliasIndex()/
// resolve() verbatim (post-Round-2-write live canonical_ingredients) and
// assets/recipe_cost.service.js costRecipe() for lineCost/priceable, same
// pattern as apps/api/scripts/merge_canonical_ingredients_round2.cjs.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const { normalizeName } = require("../../../../assets/name_normalizer.js");
const { buildAliasIndex, resolve } = require("../../../../assets/canonical_resolver.service.js");
const { costRecipe } = require("../../../../assets/recipe_cost.service.js");

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

// Mirrors resolve()'s internal fuzzy pass exactly (assets/canonical_resolver.service.js),
// just also surfaces bestDist so the audit can report distance, not only method.
function resolveWithDistance(rawName, index) {
  const normalized = normalizeName(rawName);
  if (!normalized) return { unresolved: true, normalized };
  const exact = index.get(normalized);
  if (exact) return { canonical_name: exact, method: "exact", distance: 0, normalized };
  if (normalized.length < 4) return { unresolved: true, normalized };
  let best = null, bestDist = Infinity;
  for (const key of index.keys()) {
    if (Math.abs(key.length - normalized.length) > 1) continue;
    const dist = levenshtein(normalized, key);
    if (dist < bestDist) { bestDist = dist; best = key; if (dist === 0) break; }
  }
  if (best && bestDist <= 1) return { canonical_name: index.get(best), method: "fuzzy", confidence: "low", distance: bestDist, normalized };
  return { unresolved: true, normalized };
}

const VARIANT_SUFFIXES = (key) => [`${key}s`, `${key}es`, key.slice(0, -1), `${key.slice(0, -1)}s`];

async function main() {
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  try {
    const ciCol = db.collection("canonical_ingredients");
    const recipesCol = db.collection("recipes");
    const priceCol = db.collection("canonical_price_cache");

    const index = await buildAliasIndex(ciCol); // live index, quarantine excluded — same fn resolver uses in prod
    const indexEntries = [...index.entries()]; // [normalizedKey, canonical_name][]

    const allIngredientDocs = await ciCol.find({}).toArray();
    const ingredientsMap = new Map(allIngredientDocs.map((d) => [d.canonical_name, d]));
    const quarantinedNames = new Set(
      allIngredientDocs.filter((d) => d.quarantine === true).map((d) => String(d.canonical_name).toLowerCase().trim()),
    );
    const priceDocs = await priceCol.find({}).toArray();
    const priceMap = new Map(priceDocs.map((d) => [d.canonical_name, d]));

    // ---- 1+2+3: riskyPairs — every normalized-key pair (distinct canonical_name), distance <= 1 ----
    const resolveFn = (raw) => resolve(raw, index);

    const riskyPairs = [];
    for (let i = 0; i < indexEntries.length; i += 1) {
      const [keyA, canonicalA] = indexEntries[i];
      for (let j = i + 1; j < indexEntries.length; j += 1) {
        const [keyB, canonicalB] = indexEntries[j];
        if (Math.abs(keyA.length - keyB.length) > 1) continue; // distance<=1 implies len diff<=1 — safe prune, not a filter loss
        if (canonicalA === canonicalB) continue; // same target -> not a misrouting risk, skip per handoff
        const distance = levenshtein(keyA, keyB);
        if (distance > 1) continue;

        const variantMisroutes = [];
        for (const variant of VARIANT_SUFFIXES(keyA)) {
          if (!variant || index.has(variant)) continue; // already an exact key -> not a fuzzy-path case
          const res = resolveWithDistance(variant, index);
          if (res.canonical_name && res.canonical_name !== canonicalA) {
            variantMisroutes.push({ variant, normalized: res.normalized, resolvedCanonical: res.canonical_name, method: res.method, distance: res.distance });
          }
        }
        for (const variant of VARIANT_SUFFIXES(keyB)) {
          if (!variant || index.has(variant)) continue;
          const res = resolveWithDistance(variant, index);
          if (res.canonical_name && res.canonical_name !== canonicalB) {
            variantMisroutes.push({ variant, normalized: res.normalized, resolvedCanonical: res.canonical_name, method: res.method, distance: res.distance });
          }
        }

        riskyPairs.push({
          keyA, canonicalA,
          keyB, canonicalB,
          distance,
          alreadySameCanonical: false,
          referenceCountA: 0, // filled below once recipe_cost lines are tallied
          referenceCountB: 0,
          variantMisroutes,
        });
      }
    }

    // ---- 4: liveFuzzyMatches — walk ALL recipes (997, not just isPublic) ----
    const allRecipes = await recipesCol.find({}).toArray();
    const liveFuzzyMatches = [];
    const referenceCounts = new Map(); // canonical_name -> count of lines in recipe_cost.lines[] (recomputed live)

    for (const r of allRecipes) {
      const cost = costRecipe(r, resolveFn, ingredientsMap, priceMap, quarantinedNames);
      const ingredientLines = r.ingredients || [];
      for (let i = 0; i < ingredientLines.length; i += 1) {
        const rawName = ingredientLines[i].name;
        const lineResult = cost.lines[i];
        if (lineResult && lineResult.canonical_name) {
          referenceCounts.set(lineResult.canonical_name, (referenceCounts.get(lineResult.canonical_name) || 0) + 1);
        }
        const resolved = resolveWithDistance(rawName, index);
        if (resolved.method === "fuzzy") {
          liveFuzzyMatches.push({
            recipe_id: r._id ? String(r._id) : null,
            recipe_title: r.title || null,
            raw_ingredient_text: rawName,
            normalized: resolved.normalized,
            matched_canonical_name: resolved.canonical_name,
            distance: resolved.distance,
            lineCost: lineResult && lineResult.priceable ? lineResult.lineCost : null,
            priceable: lineResult ? !!lineResult.priceable : false,
          });
        }
      }
    }

    for (const pair of riskyPairs) {
      pair.referenceCountA = referenceCounts.get(pair.canonicalA) || 0;
      pair.referenceCountB = referenceCounts.get(pair.canonicalB) || 0;
    }

    const output = {
      generatedAt: new Date().toISOString(),
      indexSize: index.size,
      riskyPairs,
      liveFuzzyMatches,
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(__dirname, "..", "..", "..", "..", "summaries");
    const jsonPath = path.join(outDir, `${dateStr}_resolver-fuzzy-match-audit.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

    const sameCanonicalSkipped = (() => {
      // Recount how many pairs were skipped purely because canonicalA === canonicalB,
      // for the summary md's "false alarm" count (re-scan without that skip).
      let skipped = 0;
      for (let i = 0; i < indexEntries.length; i += 1) {
        const [keyA, canonicalA] = indexEntries[i];
        for (let j = i + 1; j < indexEntries.length; j += 1) {
          const [keyB, canonicalB] = indexEntries[j];
          if (Math.abs(keyA.length - keyB.length) > 1) continue;
          if (canonicalA !== canonicalB) continue;
          if (levenshtein(keyA, keyB) <= 1) skipped += 1;
        }
      }
      return skipped;
    })();

    console.log("indexSize:", index.size);
    console.log("riskyPairs (distinct canonical, distance<=1):", riskyPairs.length);
    console.log("same-canonical false alarms skipped:", sameCanonicalSkipped);
    console.log("liveFuzzyMatches (recipes x ingredient lines, method:fuzzy):", liveFuzzyMatches.length);
    console.log("wrote:", jsonPath);

    fs.writeFileSync(
      path.join(outDir, `${dateStr}_resolver-fuzzy-match-audit_meta.json`),
      JSON.stringify({ sameCanonicalFalseAlarmsSkipped: sameCanonicalSkipped }, null, 2),
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("audit failed:", err.message);
  process.exit(1);
});
