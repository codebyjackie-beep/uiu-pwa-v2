// Part C apply (cloud review approved 2026-10-12): remove the stray "snack" tag (keep "appetizer") from
// soups / curries / risotto that are only reachable as snack/appetizer.
//
//   node scripts/partC_apply.cjs                                              # dry run (read-only, re-checks live DB)
//   node scripts/partC_apply.cjs --write --from ../../summaries/partC_mealtype_dryrun_2026-10-12.json [--batch partC-...]
//   node scripts/partC_rollback.cjs <batch> [--write]                         # undo
//
// Only rows of the REVIEWED file whose suggestedAction starts with `remove tag "snack"` are touched (15).
// The 3 `keep` rows are asserted by title and never written.
// Guards (any failure aborts the whole run, nothing is written): recipe still public, tags still contain
// snack + appetizer, current classes equal the reviewed file, simulated classes contain lunch or dinner.
// Reversible: original tags kept in `tagsOriginal`, batch marker `partCBatch`.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { MongoClient, ObjectId } = require("mongodb");

const WRITE = process.argv.includes("--write");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const FROM = argAfter("--from");
const REVIEWED_FILE = path.resolve(__dirname, "../../../summaries/partC_mealtype_dryrun_2026-10-12.json");
const OUT_DRYRUN = path.resolve(__dirname, "../../../summaries/partC_apply_dryrun_2026-10-12.json");
const KEEP_TITLES = new Set([
  "Xocai Oatmeal Dark Chocolate No-Bake Cookies",
  "Baked Indian Samosas",
  "High-Protein Japanese Curry Puffs",
]);
const EXPECT_REMOVE = 15;
const EXPECT_KEEP = 3;

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const isSnack = (t) => String(t).trim().toLowerCase() === "snack";
const sorted = (set) => [...set].sort();

(async () => {
  const env = loadDevVars();
  const { classifyRecipeMealTypes: classify } = await import(
    pathToFileURL(path.resolve(__dirname, "../../../packages/shared/dist/index.js")).href
  );
  const reviewedPath = FROM ? path.resolve(process.cwd(), FROM) : REVIEWED_FILE;
  const reviewed = JSON.parse(fs.readFileSync(reviewedPath, "utf8"));
  const removeRows = reviewed.rows.filter((r) => r.suggestedAction.startsWith('remove tag "snack"'));
  const keepRows = reviewed.rows.filter((r) => !r.suggestedAction.startsWith('remove tag "snack"'));
  if (removeRows.length !== EXPECT_REMOVE || keepRows.length !== EXPECT_KEEP) {
    throw new Error(`reviewed file has ${removeRows.length} remove / ${keepRows.length} keep, expected ${EXPECT_REMOVE} / ${EXPECT_KEEP}`);
  }
  for (const k of keepRows) if (!KEEP_TITLES.has(k.title)) throw new Error(`unexpected keep row: ${k.title}`);

  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const col = client.db(env.MONGODB_DB).collection("recipes");
    const problems = [];
    const plan = [];
    for (const row of removeRows) {
      const r = await col.findOne({ _id: new ObjectId(row.id) });
      if (!r) { problems.push(`${row.id} not found`); continue; }
      if (r.isPublic !== true) problems.push(`${row.id} ${r.title}: not public`);
      if (r.title !== row.title) problems.push(`${row.id}: title changed (${r.title})`);
      if (r.partCBatch) problems.push(`${row.id} ${r.title}: already carries partCBatch ${r.partCBatch}`);
      const tags = Array.isArray(r.tags) ? r.tags : [];
      if (!tags.some(isSnack)) problems.push(`${row.id} ${r.title}: no snack tag any more`);
      if (!tags.some((t) => String(t).trim().toLowerCase() === "appetizer")) problems.push(`${row.id} ${r.title}: no appetizer tag`);
      const classBefore = sorted(classify({ title: r.title, tags, mealType: r.mealType }));
      if (classBefore.join() !== [...row.currentClasses].sort().join()) problems.push(`${row.id} ${r.title}: classes ${classBefore} != reviewed ${row.currentClasses}`);
      const tagsAfter = tags.filter((t) => !isSnack(t));
      const classAfter = sorted(classify({ title: r.title, tags: tagsAfter, mealType: r.mealType }));
      if (!classAfter.includes("lunch") && !classAfter.includes("dinner")) problems.push(`${row.id} ${r.title}: after = ${classAfter} has no lunch/dinner`);
      plan.push({ id: row.id, title: r.title, tagsBefore: tags, tagsAfter, classBefore, classAfter });
    }
    for (const k of keepRows) {
      const r = await col.findOne({ _id: new ObjectId(k.id) }, { projection: { title: 1, tags: 1, partCBatch: 1 } });
      if (!r || r.title !== k.title) problems.push(`keep row ${k.id} (${k.title}) missing or renamed`);
    }
    for (const p of plan) {
      console.log(`${p.id}  [${p.classBefore.join(",")}] -> [${p.classAfter.join(",")}]  tags ${JSON.stringify(p.tagsBefore)} -> ${JSON.stringify(p.tagsAfter)}  ${p.title}`);
    }
    if (problems.length) {
      console.error("ABORT - guard failures:\n  " + problems.join("\n  "));
      process.exit(1);
    }

    if (!WRITE) {
      fs.writeFileSync(OUT_DRYRUN, JSON.stringify({ generatedAt: new Date().toISOString(), source: path.basename(reviewedPath), remove: plan, keep: keepRows.map((k) => ({ id: k.id, title: k.title })) }, null, 2));
      console.log(`dry run OK: ${plan.length} to change, ${keepRows.length} kept. -> ${OUT_DRYRUN}`);
      return;
    }

    const batch = argAfter("--batch") || `partC-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const at = new Date();
    let modified = 0;
    for (const p of plan) {
      const res = await col.updateOne(
        { _id: new ObjectId(p.id), partCBatch: { $exists: false } },
        { $set: { tags: p.tagsAfter, tagsOriginal: p.tagsBefore, partCBatch: batch, partCAt: at } },
      );
      modified += res.modifiedCount;
    }
    console.log(`WRITE batch ${batch}: modified ${modified} of ${plan.length}`);
    if (modified !== plan.length) { console.error("WARNING: modified count != plan size"); process.exitCode = 1; }

    // re-query evidence
    const afterRows = [];
    for (const p of plan) {
      const r = await col.findOne({ _id: new ObjectId(p.id) });
      afterRows.push({ id: p.id, title: r.title, tags: r.tags, classBefore: p.classBefore, classAfter: sorted(classify({ title: r.title, tags: r.tags, mealType: r.mealType })) });
    }
    const keepAfter = [];
    for (const k of keepRows) {
      const r = await col.findOne({ _id: new ObjectId(k.id) });
      keepAfter.push({ id: k.id, title: r.title, tags: r.tags, classes: sorted(classify({ title: r.title, tags: r.tags, mealType: r.mealType })), untouched: !r.partCBatch });
    }
    const publicRecipes = await col.find({ isPublic: true }).project({ title: 1, tags: 1, mealType: 1 }).toArray();
    const perChip = {};
    let unreachable = 0;
    for (const r of publicRecipes) {
      const set = classify({ title: r.title, tags: Array.isArray(r.tags) ? r.tags : [], mealType: r.mealType });
      if (set.size === 0) unreachable += 1;
      for (const c of set) perChip[c] = (perChip[c] || 0) + 1;
    }
    const appliedFile = path.resolve(__dirname, `../../../summaries/${batch}_applied.json`);
    const evidence = { batch, appliedAt: at.toISOString(), source: path.basename(reviewedPath), modified, changed: afterRows, kept: keepAfter, public: { recipes: publicRecipes.length, perChip, unreachableByAnyChip: unreachable } };
    fs.writeFileSync(appliedFile, JSON.stringify(evidence, null, 2));
    for (const a of afterRows) console.log(`after  [${a.classBefore.join(",")}] -> [${a.classAfter.join(",")}]  ${a.title}`);
    for (const k of keepAfter) console.log(`keep   [${k.classes.join(",")}] untouched=${k.untouched}  ${k.title}`);
    console.log(`public ${publicRecipes.length}; perChip ${JSON.stringify(perChip)}; unreachable by any chip: ${unreachable}`);
    console.log(`-> ${appliedFile}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
