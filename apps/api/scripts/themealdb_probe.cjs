// Probe TheMealDB: list categories and count unique meal ids per category.
// Read-only, no writes. Used to size Part B before running the full import.
const fs = require("fs");
const path = require("path");

const KEY_RAW = fs.readFileSync(path.resolve(__dirname, "../../../../Key/themealdb-api-key.txt"), "utf8");
const KEY_MATCHES = KEY_RAW.match(/\d+/g) || [];
const KEY = KEY_MATCHES[KEY_MATCHES.length - 1];
if (!KEY) throw new Error("Could not extract numeric TheMealDB key from Key/themealdb-api-key.txt");
const BASE = `https://www.themealdb.com/api/json/v2/${KEY}`;

async function main() {
  const catRes = await fetch(`${BASE}/list.php?c=list`);
  console.log("status:", catRes.status, catRes.headers.get("content-type"));
  const text = await catRes.text();
  console.log("body (first 300 chars):", text.slice(0, 300));
  const catJson = JSON.parse(text);
  const categories = (catJson.meals || []).map((m) => m.strCategory);
  console.log(`Categories (${categories.length}):`, categories.join(", "));

  let total = 0;
  const perCat = {};
  for (const cat of categories) {
    const r = await fetch(`${BASE}/filter.php?c=${encodeURIComponent(cat)}`);
    const j = await r.json();
    const n = (j.meals || []).length;
    perCat[cat] = n;
    total += n;
    await new Promise((res) => setTimeout(res, 150));
  }
  console.log("Per-category counts:", JSON.stringify(perCat, null, 2));
  console.log("Total meals (sum across categories):", total);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
