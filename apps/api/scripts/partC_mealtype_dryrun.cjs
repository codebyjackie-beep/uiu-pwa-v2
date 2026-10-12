// Part C (cc prompt 2026-10-12): READ-ONLY. Public recipes whose title says "main-dish food"
// (stew|curry|soup|chili|chowder|casserole|noodle|pasta|risotto|bake) but whose meal classes contain
// neither lunch nor dinner (i.e. only snack / appetizer / dessert / breakfast).
//   node scripts/partC_mealtype_dryrun.cjs   -> summaries/partC_mealtype_dryrun_2026-10-12.json
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { MongoClient } = require("mongodb");

const TITLE_RE = /stew|curry|soup|chili|chowder|casserole|noodle|pasta|risotto|bake/i;
const SLOT_TAGS = new Set(["breakfast", "brunch", "lunch", "dinner", "snack", "dessert", "appetizer"]);

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

(async () => {
  const env = loadDevVars();
  const { classifyRecipeMealTypes } = await import(pathToFileURL(path.resolve(__dirname, "../../../packages/shared/dist/index.js")).href);
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  try {
    const recipes = await client.db(env.MONGODB_DB).collection("recipes").find({ isPublic: true }).project({ title: 1, tags: 1, mealType: 1, source: 1 }).toArray();
    const rows = [];
    let titleMatches = 0;
    for (const r of recipes) {
      if (!TITLE_RE.test(r.title)) continue;
      titleMatches += 1;
      const tags = Array.isArray(r.tags) ? r.tags : [];
      const classes = [...classifyRecipeMealTypes({ title: r.title, tags, mealType: r.mealType })].sort();
      if (classes.includes("lunch") || classes.includes("dinner")) continue;
      const drivers = [...new Set([...tags.map((t) => t.toLowerCase()), String(r.mealType || "").trim().toLowerCase()].filter((t) => SLOT_TAGS.has(t)))];
      rows.push({
        id: String(r._id),
        title: r.title,
        currentClasses: classes,
        slotTagsPresent: drivers,
        mealType: r.mealType ?? null,
        source: r.source ?? null,
        suggestedClasses: ["lunch", "dinner"],
        // The classifier adds mealType as a tag and slots come from tags[] (snack/breakfast/lunch/dinner),
        // so "lunch,dinner" is reached by REMOVING the stray "snack" tag (keep "appetizer"), not by a mealType string.
        suggestedAction: /cookie|puff|samosa|bar|bite/i.test(r.title) || drivers.includes("dessert")
          ? "keep (finger food / dessert: snack is correct)"
          : "remove tag \"snack\" (keep \"appetizer\") -> classifier gives " + (/soup|chowder|bisque/i.test(r.title) ? "lunch (+appetizer)" : "lunch+dinner (+appetizer)"),
      });
    }
    const out = { generatedAt: new Date().toISOString(), publicRecipes: recipes.length, titleMatches, flagged: rows.length, rows };
    const file = path.resolve(__dirname, "../../../summaries/partC_mealtype_dryrun_2026-10-12.json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`public ${recipes.length}; title matches ${titleMatches}; no lunch/dinner class: ${rows.length}`);
    for (const r of rows) console.log(`${r.id}  [${r.currentClasses.join(",")}]  tags:${r.slotTagsPresent.join("|") || "-"}  mealType:${r.mealType ?? "-"}  ${r.title}`);
    console.log(`-> ${file}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
