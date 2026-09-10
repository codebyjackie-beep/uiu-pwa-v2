// cc_prompt_recompute-costs_aggregate_quirk (2026-09-10)
// Controlled test: mutate canonical_price_cache.sugar.per_unit_metric.value to a
// distinctive test value, run recompute-costs?write=true over HTTP, confirm
// (a) the recipe_cost doc-level lineCost for "sugar" lines actually changed
// (proves the write path used the new price), and (b) whether the aggregate
// stats returned by the same call (lineWeightedAdjustedPct etc.) moved.
// Reverts the price back to the original value at the end, regardless of outcome.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { MongoClient } = require("mongodb");

function loadDevVars() {
  const p = path.resolve(__dirname, "..", ".dev.vars");
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

function httpPost(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { "X-Admin-Token": token } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const BASE_URL = "https://uiu-api.codeby-jackie.workers.dev";
const TEST_VALUE = 0.5; // was 0.00145 — a ~345x jump, impossible to miss in lineCost if it flows through

(async () => {
  const env = loadDevVars();
  const token = env.ADMIN_TOKEN;
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const priceCol = db.collection("canonical_price_cache");
  const costCol = db.collection("recipe_cost");

  const evidence = { steps: [] };

  try {
    // Step 0: baseline aggregate (dry-run, no mutation yet)
    const baseline = await httpPost(`${BASE_URL}/api/admin/recompute-costs`, token);
    console.log("Step 0 - baseline dry-run:", JSON.stringify(baseline.body));
    evidence.steps.push({ step: "baseline_dryrun", result: baseline.body });

    // Step 1: find a live recipe_cost doc currently using "sugar" as a priceable line
    const beforeDoc = await costCol.findOne({ "lines.canonical_name": "sugar", "lines.priceable": true });
    if (!beforeDoc) throw new Error("No recipe_cost doc with a priceable 'sugar' line found — pick a different test ingredient.");
    const beforeLine = beforeDoc.lines.find((l) => l.canonical_name === "sugar" && l.priceable === true);
    console.log("Step 1 - sample doc before mutation:", beforeDoc.recipeId, JSON.stringify(beforeLine));
    evidence.steps.push({ step: "sample_before", recipeId: beforeDoc.recipeId, line: beforeLine });

    // Step 2: mutate canonical_price_cache.sugar.per_unit_metric.value
    const priceDoc = await priceCol.findOne({ canonical_name: "sugar" });
    const originalValue = priceDoc.per_unit_metric.value;
    console.log(`Step 2 - mutating sugar per_unit_metric.value: ${originalValue} -> ${TEST_VALUE}`);
    await priceCol.updateOne({ canonical_name: "sugar" }, { $set: { "per_unit_metric.value": TEST_VALUE } });
    evidence.steps.push({ step: "mutate", originalValue, testValue: TEST_VALUE });

    // Step 3: trigger real write via the actual HTTP endpoint (not a local call)
    const writeResult = await httpPost(`${BASE_URL}/api/admin/recompute-costs?write=true`, token);
    console.log("Step 3 - write=true result:", JSON.stringify(writeResult.body));
    evidence.steps.push({ step: "write_true", result: writeResult.body });

    // Step 4: confirm doc-level lineCost actually changed for the sugar line
    const afterDoc = await costCol.findOne({ recipeId: beforeDoc.recipeId });
    const afterLine = afterDoc.lines.find((l) => l.canonical_name === "sugar");
    console.log("Step 4 - same doc after mutation+write:", JSON.stringify(afterLine));
    evidence.steps.push({ step: "sample_after", line: afterLine });

    // Step 5: compare aggregate stats before vs after
    const aggregateChanged =
      baseline.body.data.lineWeightedAdjustedPct !== writeResult.body.data.lineWeightedAdjustedPct ||
      baseline.body.data.adjustedPriceableTotal !== writeResult.body.data.adjustedPriceableTotal ||
      baseline.body.data.adjustedTotalSum !== writeResult.body.data.adjustedTotalSum;
    console.log(`\nStep 5 - aggregate changed after price mutation? ${aggregateChanged}`);
    console.log(`  baseline.lineWeightedAdjustedPct=${baseline.body.data.lineWeightedAdjustedPct}`);
    console.log(`  write.lineWeightedAdjustedPct=${writeResult.body.data.lineWeightedAdjustedPct}`);
    console.log(`  lineCost changed? before=${beforeLine.lineCost} after=${afterLine.lineCost}`);
    evidence.aggregateChanged = aggregateChanged;
    evidence.lineCostChanged = beforeLine.lineCost !== afterLine.lineCost;
  } finally {
    // Step 6: ALWAYS revert the price mutation, then re-run write=true to restore correct recipe_cost data
    console.log("\nStep 6 - reverting price mutation and re-running recompute-costs?write=true to restore correct data...");
    await priceCol.updateOne({ canonical_name: "sugar" }, { $set: { "per_unit_metric.value": 0.00145 } });
    const restoreResult = await httpPost(`${BASE_URL}/api/admin/recompute-costs?write=true`, token);
    console.log("Restore result:", JSON.stringify(restoreResult.body));
    evidence.steps.push({ step: "restore", result: restoreResult.body });

    fs.writeFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "summaries", "2026-09-10_recompute-costs-aggregate-quirk-evidence.json"),
      JSON.stringify(evidence, null, 2)
    );
    await client.close();
  }
})();
