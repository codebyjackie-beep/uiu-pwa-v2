// Read-only inspection for cc_prompt_canonical_skip_list_cleanup.md (2026-09-09).
// Dumps current state of the 28 skip-list entries, plus checks whether any of the
// proposed split-target canonical_names already exist (to avoid creating duplicates).
const fs = require("fs");
const path = require("path");
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

const ROUND1 = [
  "skewers",
  "sugar substitute",
  "seasoning",
  "seafood seasoning",
  "sweetner",
  "honey or maple syrup",
  "plain greek yogurt or sour cream",
  "corn or flour tortillas",
];

const ROUND2 = [
  "grape seed",
  "to 5 garlic cloves",
  "wooden skewers",
  "i gem lettuce",
  "dale's seasoning",
  "pcs lemon",
  "sriracha or red pepper flakes",
  "cream of chicken or mushroom soup (condensed)",
  "cream of mushroom or chicken soup (condensed)",
  "fresh parsley or dill",
  "single or double cream",
  "you can use regular basil",
  "black bean burgers (store-bought or homemade)",
  "water or vegetable broth",
  "yoghurt sauce",
  "milk or chicken broth",
  "maple syrup or honey",
  "white wine vinegar or lemon juice",
  "salt and black pepper",
  "grain tortillas",
];

const SPLIT_TARGET_CANDIDATES = [
  "honey", "maple syrup", "plain greek yogurt", "sour cream", "corn tortillas", "flour tortillas",
  "sriracha", "red pepper flakes", "fresh parsley", "fresh dill", "single cream", "double cream",
  "water", "vegetable broth", "milk", "chicken broth", "white wine vinegar", "lemon juice",
  "salt", "black pepper", "cream of chicken soup (condensed)", "cream of mushroom soup (condensed)",
];

(async () => {
  const env = loadDevVars();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const col = db.collection("canonical_ingredients");

  const all28 = [...ROUND1, ...ROUND2];
  console.log("=== 28 skip-list entries: current state ===");
  for (const name of all28) {
    const doc = await col.findOne({ canonical_name: name });
    if (!doc) {
      console.log(`MISSING: "${name}" — no canonical_ingredients doc found with this exact name`);
      continue;
    }
    console.log(
      JSON.stringify({
        canonical_name: doc.canonical_name,
        aliases: doc.aliases,
        quarantine: doc.quarantine ?? false,
        referenceCount: doc.referenceCount,
        nutrition_per_100g: doc.nutrition_per_100g ? "present" : "absent",
        density_cup: doc.density_cup,
        per_item_g: doc.per_item_g,
      }),
    );
  }

  console.log("\n=== Split-target candidates: do they already exist as separate canonical entries? ===");
  for (const name of SPLIT_TARGET_CANDIDATES) {
    const doc = await col.findOne({ canonical_name: name });
    if (doc) {
      console.log(
        `EXISTS: "${name}" — ${JSON.stringify({
          quarantine: doc.quarantine ?? false,
          referenceCount: doc.referenceCount,
          nutrition_per_100g: doc.nutrition_per_100g ? "present" : "absent",
        })}`,
      );
    } else {
      console.log(`does not exist: "${name}"`);
    }
  }

  const total = await col.countDocuments({});
  const quarantined = await col.countDocuments({ quarantine: true });
  console.log(`\nTotal canonical_ingredients: ${total}, quarantined: ${quarantined}`);

  await client.close();
})();
