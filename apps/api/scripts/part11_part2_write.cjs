// Part 11 v3 withdraw + Part 2 image swap. Default = dry-run (find/count only). Add --write to apply.
//   node scripts/part11_part2_write.cjs part11 [--write]
//   node scripts/part11_part2_write.cjs part2  [--write]
// Reversible: nothing is deleted. Part 11 sets isPublic:false + withdrawnBatch marker; Part 2 keeps the
// old URL in imageUrlPrev + imageBatch marker. Undo with scripts/part11_part2_rollback.cjs <batchId>.
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const SKIP_IDS = new Set("6ac80d84b0ca951a2fbf7484 6ac80d8eb0ca951a2fbf74a8 6ac80dd0b0ca951a2fbf7590 6ac80dc8b0ca951a2fbf7572 69d1933f0ce7d5269f69526d 69d1933f0ce7d5269f695271 69d1933f0ce7d5269f695276 69d1933f0ce7d5269f695269 6ac80db2b0ca951a2fbf7526 6ac80e17b0ca951a2fbf768a 6ac80e25b0ca951a2fbf76ba 6ac80d59b0ca951a2fbf73ee 6ac80e18b0ca951a2fbf768c 6ac80e29b0ca951a2fbf76c8".split(" "));

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
const S = (f) => path.resolve(__dirname, "../../../summaries", f);

async function main() {
  const mode = process.argv[2];
  const write = process.argv.includes("--write");
  if (!["part11", "part2", "part2r2"].includes(mode)) throw new Error("mode must be part11|part2|part2r2");
  const { MONGODB_URI, MONGODB_DB } = loadDevVars();
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const col = db.collection("recipes");
    const batchId = `${mode}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
    const now = new Date();

    if (mode === "part11") {
      const ids = JSON.parse(fs.readFileSync(S("2026-10-10_part11-dryrun-v3.json"), "utf8")).withdrawIds;
      const oids = ids.map((i) => new ObjectId(i));
      const prot = new Set();
      for (const m of await db.collection("meal_plans").find({}).project({ recipeId: 1 }).toArray()) prot.add(String(m.recipeId));
      for (const f of await db.collection("favourite_recipes").find({}).project({ recipeId: 1 }).toArray()) prot.add(String(f.recipeId));
      const protectedHit = ids.filter((i) => prot.has(i));
      const pubNow = await col.countDocuments({ isPublic: true });
      const targets = await col.countDocuments({ _id: { $in: oids }, isPublic: true });
      console.log(JSON.stringify({ mode, write, listed: ids.length, uniqueListed: new Set(ids).size, stillPublicTargets: targets, protectedHit: protectedHit.length, publicNow: pubNow, expectedPublicAfter: pubNow - targets }));
      if (protectedHit.length || targets !== ids.length) throw new Error("pre-check failed; refusing");
      if (!write) return;
      const r = await col.updateMany({ _id: { $in: oids }, isPublic: true }, { $set: { isPublic: false, withdrawnAt: now, withdrawnBatch: batchId, withdrawnReason: "part11-dedupe-v3" } });
      console.log("BATCH", batchId, "matched", r.matchedCount, "modified", r.modifiedCount, "publicAfter", await col.countDocuments({ isPublic: true }));
      fs.writeFileSync(S(`2026-10-10_${batchId}_applied.json`), JSON.stringify({ batchId, mode, at: now.toISOString(), ids }, null, 2));
    } else if (mode === "part2r2") {
      // Round-2 picks (Jackie-chosen) + clearing the dead-image recipe (UI falls back to the grey placeholder box).
      const PICKS = {
        "6ac80d84b0ca951a2fbf7484": 13119151, "6ac80dd0b0ca951a2fbf7590": 14302150, "6ac80dc8b0ca951a2fbf7572": 19589060,
        "69d1933f0ce7d5269f695271": 6617983, "69d1933f0ce7d5269f695276": 8983397, "69d1933f0ce7d5269f695269": 37648027,
        "6ac80db2b0ca951a2fbf7526": 28286173, "6ac80e17b0ca951a2fbf768a": 35041660, "6ac80e25b0ca951a2fbf76ba": 5774010,
        "6ac80d59b0ca951a2fbf73ee": 18743144, "6ac80e18b0ca951a2fbf768c": 5881013, "6ac80e29b0ca951a2fbf76c8": 5981144,
      };
      const CLEAR = ["69d1933f0ce7d5269f69526d"];
      const r1 = JSON.parse(fs.readFileSync(S("2026-10-10_part2-dryrun-v2.json"), "utf8")).needNewPhoto;
      const r2 = JSON.parse(fs.readFileSync(S("2026-10-10_part2-round2-dryrun.json"), "utf8")).recipes;
      const rows = [];
      for (const [rid, pid] of Object.entries(PICKS)) {
        const cand = r2.find((x) => x.recipeId === rid).candidates.find((c) => c.pexelsId === pid);
        if (!cand) throw new Error("pick not in round-2 candidates: " + rid);
        const o = r1.find((x) => x.recipeId === rid);
        rows.push({ recipeId: rid, title: o.title, expectPrev: o.currentImageUrl, newUrl: cand.srcLarge, pexelsId: pid });
      }
      for (const rid of CLEAR) { const o = r1.find((x) => x.recipeId === rid); rows.push({ recipeId: rid, title: o.title, expectPrev: o.currentImageUrl, newUrl: "", pexelsId: null }); }
      const cur = new Map((await col.find({ _id: { $in: rows.map((x) => new ObjectId(x.recipeId)) } }).project({ imageUrl: 1, isPublic: 1 }).toArray()).map((d) => [String(d._id), d]));
      const bad = rows.filter((x) => !cur.has(x.recipeId) || cur.get(x.recipeId).imageUrl !== x.expectPrev || !cur.get(x.recipeId).isPublic);
      const usedElsewhere = (await col.find({ imageUrl: { $in: rows.map((x) => x.newUrl).filter(Boolean) } }).project({ _id: 1 }).toArray()).length;
      console.log(JSON.stringify({ mode, write, picks: Object.keys(PICKS).length, clear: CLEAR.length, toWrite: rows.length, driftOrMissing: bad.length, uniquePexels: new Set(rows.filter((x) => x.pexelsId).map((x) => x.pexelsId)).size, newUrlAlreadyUsedByAnyRecipe: usedElsewhere }));
      if (bad.length || usedElsewhere) throw new Error("pre-check failed; refusing");
      if (!write) return;
      let modified = 0;
      const backup = [];
      for (const x of rows) {
        const r = await col.updateOne({ _id: new ObjectId(x.recipeId), imageUrl: x.expectPrev }, { $set: { imageUrl: x.newUrl, imageUrlPrev: x.expectPrev, imageBatch: batchId, imageChangedAt: now, imagePexelsId: x.pexelsId } });
        modified += r.modifiedCount;
        backup.push({ recipeId: x.recipeId, title: x.title, prev: x.expectPrev, now: x.newUrl });
      }
      console.log("BATCH", batchId, "modified", modified);
      fs.writeFileSync(S(`2026-10-10_${batchId}_applied.json`), JSON.stringify({ batchId, mode, at: now.toISOString(), rows: backup }, null, 2));
    } else {
      const p2 = JSON.parse(fs.readFileSync(S("2026-10-10_part2-dryrun-v2.json"), "utf8")).needNewPhoto;
      const rows = p2.filter((x) => !SKIP_IDS.has(x.recipeId));
      const cur = new Map((await col.find({ _id: { $in: rows.map((x) => new ObjectId(x.recipeId)) } }).project({ imageUrl: 1, isPublic: 1 }).toArray()).map((d) => [String(d._id), d]));
      const bad = rows.filter((x) => !cur.has(x.recipeId) || cur.get(x.recipeId).imageUrl !== x.currentImageUrl || !cur.get(x.recipeId).isPublic);
      console.log(JSON.stringify({ mode, write, needNewPhoto: p2.length, skipped: p2.length - rows.length, toWrite: rows.length, driftOrMissing: bad.length, uniquePexels: new Set(rows.map((x) => x.suggestion.pexelsId)).size }));
      if (bad.length) { console.log(bad.map((b) => b.recipeId + " " + b.title)); throw new Error("pre-check failed; refusing"); }
      if (!write) return;
      let modified = 0;
      const backup = [];
      for (const x of rows) {
        const id = new ObjectId(x.recipeId);
        const prev = cur.get(x.recipeId).imageUrl;
        const r = await col.updateOne({ _id: id, imageUrl: prev }, { $set: { imageUrl: x.suggestion.srcLarge, imageUrlPrev: prev, imageBatch: batchId, imageChangedAt: now, imagePexelsId: x.suggestion.pexelsId } });
        modified += r.modifiedCount;
        backup.push({ recipeId: x.recipeId, title: x.title, prev, now: x.suggestion.srcLarge });
      }
      console.log("BATCH", batchId, "modified", modified);
      fs.writeFileSync(S(`2026-10-10_${batchId}_applied.json`), JSON.stringify({ batchId, mode, at: now.toISOString(), rows: backup }, null, 2));
    }
  } finally { await client.close(); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
