// Read-only investigation script (HANDOFF: query duplicate-naming + "Weekly Plan N" logic).
// Not a fix — no writes. Reports current meal_plan_sets docs and any duplicate names.
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

function loadDevVars() {
  const raw = fs.readFileSync(path.join(__dirname, "..", ".dev.vars"), "utf8");
  const vars = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

async function main() {
  const vars = loadDevVars();
  const client = new MongoClient(vars.MONGODB_URI);
  await client.connect();
  const db = client.db(vars.MONGODB_DB);

  const docs = await db.collection("meal_plan_sets").find({}).sort({ createdAt: 1 }).toArray();
  console.log(`Total meal_plan_sets docs: ${docs.length}`);
  for (const d of docs) {
    console.log(`  _id=${d._id} name="${d.name}" isActive=${d.isActive} createdAt=${d.createdAt}`);
  }

  const byName = new Map();
  for (const d of docs) {
    const list = byName.get(d.name) ?? [];
    list.push(d._id.toString());
    byName.set(d.name, list);
  }
  const dupes = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`\nDuplicate names found: ${dupes.length}`);
  for (const [name, ids] of dupes) {
    console.log(`  "${name}" -> ${ids.join(", ")}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
