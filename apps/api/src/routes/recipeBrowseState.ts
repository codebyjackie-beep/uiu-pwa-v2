/**
 * HANDOFF_recipes-page-manual-entry-and-refresh.md §B — server-tracked daily
 * quota for the "random 10 + Refresh" default browse view. Single doc,
 * same pattern as recipe_draft_state (recipeDraftGenerator.ts readDraftState).
 * Server UTC date — single-user product feature, no timezone precision needed.
 */
import { Hono } from "hono";
import type { Document } from "mongodb";
import type { ApiResponse } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const recipeBrowseStateRouter = new Hono<{ Bindings: DbEnv }>();

const DAILY_LIMIT = 3;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readCount(env: DbEnv): Promise<number> {
  return withDb(env, async (db) => {
    const doc = (await db.collection("recipe_browse_state").findOne({})) as Document | null;
    if (!doc || doc.date !== todayUTC()) return 0;
    return (doc.refreshCount as number) ?? 0;
  });
}

recipeBrowseStateRouter.get("/refresh-status", async (c) => {
  try {
    const count = await readCount(c.env);
    const body: ApiResponse<{ remainingToday: number }> = { ok: true, data: { remainingToday: Math.max(0, DAILY_LIMIT - count) } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-browse refresh-status error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to read refresh status" } };
    return c.json(body, 502);
  }
});

recipeBrowseStateRouter.post("/refresh", async (c) => {
  try {
    const result = await withDb(c.env, async (db) => {
      const today = todayUTC();
      const doc = (await db.collection("recipe_browse_state").findOne({})) as Document | null;
      const currentCount = doc && doc.date === today ? ((doc.refreshCount as number) ?? 0) : 0;
      if (currentCount >= DAILY_LIMIT) return { limitReached: true as const };

      const nextCount = currentCount + 1;
      await db.collection("recipe_browse_state").updateOne(
        {},
        { $set: { date: today, refreshCount: nextCount, updatedAt: new Date().toISOString() } },
        { upsert: true },
      );
      return { remainingToday: DAILY_LIMIT - nextCount };
    });

    if ("limitReached" in result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "limit_reached", message: "You've used today's 3 refreshes — come back tomorrow." } };
      return c.json(body, 400);
    }
    const body: ApiResponse<{ remainingToday: number }> = { ok: true, data: { remainingToday: result.remainingToday } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-browse refresh error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to record refresh" } };
    return c.json(body, 502);
  }
});
