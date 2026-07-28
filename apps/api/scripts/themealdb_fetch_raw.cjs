// Part B step 1: fetch the full TheMealDB catalogue and save raw responses.
// Read-only against TheMealDB; writes only to assets/themealdb_raw/meals_raw.json.
const fs = require("fs");
const path = require("path");

const KEY_RAW = fs.readFileSync(path.resolve(__dirname, "../../../../Key/themealdb-api-key.txt"), "utf8");
const KEY_MATCHES = KEY_RAW.match(/\d+/g) || [];
const KEY = KEY_MATCHES[KEY_MATCHES.length - 1];
if (!KEY) throw new Error("Could not extract numeric TheMealDB key from Key/themealdb-api-key.txt");

const BASE = `https://www.themealdb.com/api/json/v2/${KEY}`;
const OUT_PATH = path.resolve(__dirname, "../../../../assets/themealdb_raw/meals_raw.json");
const DELAY_MS = 150;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function main() {
  const catRes = await fetch(`${BASE}/list.php?c=list`);
  const catJson = await catRes.json();
  const categories = (catJson.meals || []).map((m) => m.strCategory);
  console.log(`Categories (${categories.length}): ${categories.join(", ")}`);

  const idSet = new Map(); // idMeal -> category (first seen)
  for (const cat of categories) {
    const r = await fetch(`${BASE}/filter.php?c=${encodeURIComponent(cat)}`);
    const j = await r.json();
    for (const m of j.meals || []) {
      if (!idSet.has(m.idMeal)) idSet.set(m.idMeal, cat);
    }
    await sleep(DELAY_MS);
  }
  const ids = [...idSet.keys()];
  console.log(`Unique meal ids to fetch: ${ids.length}`);

  const meals = [];
  const failed = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const r = await fetch(`${BASE}/lookup.php?i=${id}`);
      const j = await r.json();
      const meal = (j.meals || [])[0];
      if (meal) meals.push(meal);
      else failed.push(id);
    } catch (err) {
      failed.push(id);
    }
    if ((i + 1) % 50 === 0 || i === ids.length - 1) {
      console.log(`  fetched ${i + 1}/${ids.length}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`Fetched ${meals.length} meal details, ${failed.length} failed: ${failed.join(", ")}`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(meals, null, 2));
  console.log(`Saved raw snapshot to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
