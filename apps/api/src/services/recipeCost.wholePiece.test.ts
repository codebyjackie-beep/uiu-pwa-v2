/**
 * Whole-piece slice rule — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/api/src/services/recipeCost.wholePiece.test.ts
 */
import { normalizeQty } from "./recipeCost";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.error("FAIL", m); } else console.log("ok  ", m); };

const canon = (name: string) => ({ canonical_name: name } as never);
const price = { per_unit_count: { value: 0.1667, unit: "each", n: 1 }, per_unit_metric: null } as never;

for (const [q, u] of [[4, "slices"], [4, "slice"], [2, "Slices"]] as const) {
  const r = normalizeQty(q, u, canon("tomato slices"), price) as { normValue?: number; bucket?: string; unpriceable?: boolean };
  ok(r.unpriceable !== true && r.normValue === 1 && r.bucket === "count", `${q} ${u} tomato slices -> 1 whole piece`);
}
const noPrice = normalizeQty(4, "slices", canon("tomato slices"), null) as { unpriceable?: boolean };
ok(noPrice.unpriceable === true, "no per_unit_count -> stays unpriceable");
const other = normalizeQty(4, "slices", canon("cheddar cheese"), price) as { unpriceable?: boolean };
ok(other.unpriceable === true, "other canonical slices stay unpriceable");
const bread = normalizeQty(2, "slices", canon("bread"), price) as { normUnit?: string; normValue?: number };
ok(bread.normUnit === "g" && bread.normValue === 72, "bread slices unchanged (2 x 36 g)");
process.exit(fails ? 1 : 0);
