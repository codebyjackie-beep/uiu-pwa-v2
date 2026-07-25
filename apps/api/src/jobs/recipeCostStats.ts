/**
 * Read-only sanity check on `recipe_cost` — lets Jackie confirm a
 * precompute write actually landed without opening the Atlas UI.
 */
import type { Document } from "mongodb";
import { withDb, type DbEnv } from "../db";

export interface RecipeCostStats {
  count: number;
  latestComputedAt: string | null;
  latestPriceCacheStamp: number | null;
}

export async function recipeCostStats(env: DbEnv): Promise<RecipeCostStats> {
  return withDb(env, async (db) => {
    const col = db.collection<Document>("recipe_cost");
    const count = await col.countDocuments();
    const latest = await col.find({}).sort({ computedAt: -1 }).limit(1).toArray();
    const doc = latest[0];
    return {
      count,
      latestComputedAt: (doc?.computedAt as string) ?? null,
      latestPriceCacheStamp: (doc?.priceCacheStamp as number) ?? null,
    };
  });
}
