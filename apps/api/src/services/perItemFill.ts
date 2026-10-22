/**
 * Fill canonical_ingredients.per_item_g for common whole produce (Jackie 2026-10-22, "補常用菜每個幾多克").
 * Without it "1 pc broccoli" can't be priced when the price cache only has £/kg, so Fridge Impact shows "£–".
 * Weights are standard UK whole-item reference weights (manual estimates, same basis as recipeCost Table C) —
 * only applied where per_item_g is currently missing; never overwrites an existing value.
 * Ambiguous items are deliberately left out (garlic: bulb ≈ 50 g vs clove ≈ 5 g; celery: head vs stick).
 */
import type { Db } from "mongodb";

export const PER_ITEM_REFERENCE_G: Record<string, number> = {
  broccoli: 350, cauliflower: 600, cabbage: 900, "red cabbage": 900, "iceberg lettuce": 500, lettuce: 300, "romaine lettuce": 300,
  cucumber: 300, avocado: 170, avocados: 170, onion: 150, onions: 150, "red onion": 150, "white onion": 150, "yellow onion": 150,
  shallot: 30, shallots: 30, lemon: 100, lemons: 100, lime: 65, limes: 65, orange: 180, apple: 180, apples: 180, banana: 120,
  bananas: 120, pear: 180, tomato: 120, tomatoes: 120, potato: 200, potatoes: 200, "sweet potato": 250, "sweet potatoes": 250,
  carrot: 70, carrots: 70, parsnip: 100, courgette: 200, zucchini: 200, aubergine: 300, eggplant: 300, "bell pepper": 160,
  "red bell pepper": 160, "green bell pepper": 160, "yellow bell pepper": 160, "red pepper": 160, "green pepper": 160, leek: 200,
  leeks: 200, mushroom: 18, mushrooms: 18, mango: 300, pineapple: 1000, "butternut squash": 1000, "spring onion": 15,
  "spring onions": 15, "green onions": 15, scallions: 15, "red chilli": 10, chili: 10, peach: 150, kiwi: 75, beetroot: 120,
  "corn on the cob": 250, fennel: 250,
};

export type PerItemPlan = { toFill: { canonical_name: string; per_item_g: number }[]; alreadySet: string[]; notFound: string[] };

export async function planPerItemFill(db: Db): Promise<PerItemPlan> {
  const names = Object.keys(PER_ITEM_REFERENCE_G);
  const docs = await db
    .collection("canonical_ingredients")
    .find({ canonical_name: { $in: names } }, { projection: { canonical_name: 1, per_item_g: 1 } })
    .toArray();
  const byName = new Map(docs.map((d) => [String(d.canonical_name), d]));
  const plan: PerItemPlan = { toFill: [], alreadySet: [], notFound: [] };
  for (const name of names) {
    const d = byName.get(name);
    if (!d) plan.notFound.push(name);
    else if (d.per_item_g != null) plan.alreadySet.push(name);
    else plan.toFill.push({ canonical_name: name, per_item_g: PER_ITEM_REFERENCE_G[name]! });
  }
  return plan;
}

/** Writes the plan; each changed doc's prior per_item_g (null) is recorded in canonical_backups under `batch`. */
export async function writePerItemFill(db: Db, batch: string): Promise<{ batch: string; updated: number; plan: PerItemPlan }> {
  const plan = await planPerItemFill(db);
  let updated = 0;
  for (const row of plan.toFill) {
    const res = await db
      .collection("canonical_ingredients")
      .updateOne({ canonical_name: row.canonical_name, per_item_g: null }, { $set: { per_item_g: row.per_item_g, per_item_g_source: "reference-2026-10-22" } });
    if (res.modifiedCount) {
      updated += 1;
      await db.collection("canonical_backups").insertOne({ batch, canonical_name: row.canonical_name, field: "per_item_g", before: null, after: row.per_item_g, at: new Date() });
    }
  }
  return { batch, updated, plan };
}

export async function rollbackPerItemFill(db: Db, batch: string): Promise<{ batch: string; reverted: number }> {
  const rows = await db.collection("canonical_backups").find({ batch, field: "per_item_g" }).toArray();
  let reverted = 0;
  for (const r of rows) {
    const res = await db
      .collection("canonical_ingredients")
      .updateOne({ canonical_name: r.canonical_name, per_item_g: r.after }, { $set: { per_item_g: r.before }, $unset: { per_item_g_source: "" } });
    if (res.modifiedCount) reverted += 1;
  }
  return { batch, reverted };
}
