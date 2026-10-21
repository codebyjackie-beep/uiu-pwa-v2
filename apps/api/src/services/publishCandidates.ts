/**
 * TheMealDB publish review (Jackie 2026-10-21): 792 recipes imported from TheMealDB were never public. Read-only
 * dry run that scores each against the bar the current 328 public recipes meet. Nothing is written here.
 * Criteria (all must pass): price coverage ≥ 80% (the "full" tier — shows a real £ number), per serving > £0 and
 * ≤ £8 (the recipe-cost gate), has an image, at least one meal slot chip, ≥ 3 ingredients and ≥ 2 steps, not a
 * near-duplicate of a public recipe or of an earlier candidate (G1 rules).
 */
import type { Db, Document } from "mongodb";
import { classifyRecipeMealTypes, findNearDuplicateRecipe, type SimilarityRecipe } from "@uiu/shared";

export type CandidateRow = {
  id: string;
  title: string;
  coveragePct: number | null;
  perServing: number | null;
  imageHost: string | null;
  mealTypes: string[];
  ingredients: number;
  steps: number;
  nearDuplicateOf: string | null;
  fails: string[];
};

const host = (u: unknown) => {
  try {
    return typeof u === "string" && u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};

export async function reviewPublishCandidates(db: Db, source: string) {
  const toSim = (d: Document): SimilarityRecipe => ({
    title: String(d.title ?? ""),
    ingredientNames: ((d.ingredients as { name?: string }[] | undefined) ?? []).map((i) => String(i.name ?? "")),
  });
  const publicRecipes = await db.collection("recipes").find({ isPublic: true }, { projection: { title: 1, "ingredients.name": 1 } }).toArray();
  const corpus: SimilarityRecipe[] = publicRecipes.map(toSim);
  const candidates = await db
    .collection("recipes")
    .find({ source, isPublic: { $ne: true }, withdrawnReason: { $exists: false }, isDeleted: { $ne: true } })
    .sort({ title: 1 })
    .toArray();
  const costs = new Map(
    (await db.collection("recipe_cost").find({ recipeId: { $in: candidates.map((c) => c._id) } }, { projection: { recipeId: 1, adjustedCoveragePct: 1, perServing: 1 } }).toArray()).map((c) => [String(c.recipeId), c]),
  );

  const rows: CandidateRow[] = [];
  for (const d of candidates) {
    const cost = costs.get(String(d._id));
    const coveragePct = typeof cost?.adjustedCoveragePct === "number" ? +cost.adjustedCoveragePct.toFixed(1) : null;
    const perServing = typeof cost?.perServing === "number" && Number.isFinite(cost.perServing) ? +cost.perServing.toFixed(2) : null;
    const mealTypes = [...classifyRecipeMealTypes({ title: String(d.title ?? ""), tags: (d.tags as string[]) ?? [], mealType: d.mealType as string | undefined })].map(String);
    const ingredients = ((d.ingredients as unknown[]) ?? []).length;
    const steps = ((d.steps as unknown[]) ?? []).length;
    const sim = toSim(d);
    const near = findNearDuplicateRecipe(sim, corpus);
    const fails: string[] = [];
    if (coveragePct === null || coveragePct < 80) fails.push("coverage<80");
    if (perServing === null || perServing <= 0) fails.push("no_price");
    else if (perServing > 8) fails.push("perServing>8");
    if (!d.imageUrl) fails.push("no_image");
    if (!mealTypes.length) fails.push("no_meal_chip");
    if (ingredients < 3) fails.push("ingredients<3");
    if (steps < 2) fails.push("steps<2");
    if (near) fails.push("near_duplicate");
    rows.push({ id: String(d._id), title: String(d.title ?? ""), coveragePct, perServing, imageHost: host(d.imageUrl), mealTypes, ingredients, steps, nearDuplicateOf: near?.title ?? null, fails });
    // Passing candidates join the corpus so two near-identical TheMealDB recipes can't both pass.
    if (!fails.length) corpus.push(sim);
  }

  const pass = rows.filter((r) => !r.fails.length);
  const failCounts: Record<string, number> = {};
  for (const r of rows) for (const f of r.fails) failCounts[f] = (failCounts[f] ?? 0) + 1;
  const bucket = (v: number) => (v < 1.5 ? "under1_5" : v <= 3 ? "1_5to3" : "3plus");
  const priceBuckets: Record<string, number> = {};
  const chips: Record<string, number> = {};
  const hosts: Record<string, number> = {};
  for (const r of pass) {
    priceBuckets[bucket(r.perServing!)] = (priceBuckets[bucket(r.perServing!)] ?? 0) + 1;
    for (const m of r.mealTypes) chips[m] = (chips[m] ?? 0) + 1;
    hosts[r.imageHost ?? "none"] = (hosts[r.imageHost ?? "none"] ?? 0) + 1;
  }
  return { source, reviewed: rows.length, pass: pass.length, failCounts, passPriceBuckets: priceBuckets, passMealChips: chips, passImageHosts: hosts, passing: pass, failingSample: rows.filter((r) => r.fails.length).slice(0, 30) };
}
