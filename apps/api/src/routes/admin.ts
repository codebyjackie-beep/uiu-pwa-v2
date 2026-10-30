import { Hono } from "hono";
import type { ApiResponse } from "@uiu/shared";
import { scanFile, RECEIPT_PROMPT } from "./fridgeStock";
import { diagnoseVideoRecipe, transcribeVideo } from "../services/openrouterVision";
import { parseRecipeFromText } from "../services/recipeImport";
import { precomputeRecipeCosts, type PrecomputeSummary } from "../jobs/precomputeRecipeCosts";
import { recipeCostStats, type RecipeCostStats } from "../jobs/recipeCostStats";
import { runDiagnostics, type DiagnosticsRunResult } from "../jobs/pwaDiagnostics";
import { sendTelegram } from "../services/telegram";
import { runIgContentBatch, runAffiliateCron, generateAndSendCollage, type BatchSummary } from "../jobs/igContentAgent";
import { renderCollageImage } from "../services/collageImage";
import { checkIgTokenHealth } from "../jobs/igTokenHealth";
import { planPerItemFill, rollbackPerItemFill, writePerItemFill } from "../services/perItemFill";
import { buildAliasIndex, resolve } from "../services/ingredientResolver";
import { estimateValueWithCanonical } from "../services/fridgeImpact";
import { runInsightsSnapshotCron } from "../jobs/igInsights";
import { planRemap, resolvePairs, rollbackRemap, scratchVerify, writeRemap, RemapInputError, USERID_COLLECTIONS, type RemapInput } from "../services/clerkRemap";
import { withDb } from "../db";
import { reviewPublishCandidates } from "../services/publishCandidates";
import { PUSH_SUBSCRIPTIONS, sendExpiryReminders, sendPush } from "../services/webPush";
import { cleanupExpiredGuests } from "../services/guest";
import { notify, setupChat, NotifyError } from "../services/cloudNotify";
import { priceRefreshRollback, recipeCostRollback, RollbackInputError } from "../services/adminRollbacks";
import { openManualRun, processPriceRefresh, getRun } from "../jobs/priceRefresh";
import { addOverride, listOverrides, OverrideInputError, removeOverrides } from "../services/priceRefreshOverrides";
import { AI_USAGE } from "../services/premium";
import { requireAdmin } from "../adminAuth";
import type { Bindings } from "../bindings";

/**
 * Inline admin endpoints, moved out of index.ts (was ~640 lines there). Mounted at /api/admin.
 * Every route here is X-Admin-Token protected by requireAdmin (adminAuth.ts) — add new admin
 * endpoints here, never back in index.ts. Run test/adminAuth.test.ts after adding one.
 */
export const adminRouter = new Hono<{ Bindings: Bindings }>();

adminRouter.use("*", requireAdmin);

// Manual trigger for the recipe_cost precompute job. Defaults to dry-run
// (never writes) so it's safe to hit over HTTP for verification. Pass
// ?write=true to opt into a real write — this is the explicit, human-watched
// path for the first-ever populate (the Cron Trigger stays disabled until
// that's verified; see wrangler.toml).
adminRouter.post("/recompute-costs", async (c) => {
  const write = c.req.query("write") === "true";
  try {
    // ?allow=<recipeId>,<recipeId> — reviewed gate anomalies that may be written anyway (still reported, flagged allowed).
    const allowIds = new Set((c.req.query("allow") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f]{24}$/.test(x)));
    const summary = await precomputeRecipeCosts(c.env, !write, allowIds.size ? allowIds : undefined);
    const body: ApiResponse<PrecomputeSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recompute-costs error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to compute recipe costs" } };
    return c.json(body, 502);
  }
});

// Clerk dev -> production cutover remap (services/clerkRemap.ts; Worker port of scripts/clerk_user_remap*.cjs).
//   POST /api/admin/clerk-remap                 body { map?: [{oldId,newId}], byEmail?: [{email,newId}] }
//        default DRY RUN (plan only); ?write=true writes (refused with 409 when blockers exist).
//   POST /api/admin/clerk-remap/rollback        body { batch } — dry run; ?write=true restores.
//   POST /api/admin/clerk-remap/scratch-verify  body as above with fake user_TEST_ new ids — copies the 12 collections
//        to a scratch DB, write + rollback there, snapshot diff, drops it. Prod is only read.
function remapError(c: any, err: unknown, where: string) {
  if (err instanceof RemapInputError) return c.json({ ok: false, error: { code: "bad_request", message: err.message } } satisfies ApiResponse<never>, 400);
  console.error(`[uiu-api] ${where} error:`, err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: { code: "db_error", message: `${where} failed` } } satisfies ApiResponse<never>, 502);
}

// Milestone 3: read-only AI usage + cost report from ai_usage (services/premium.ts).
//   GET /api/admin/ai-usage?month=YYYY-MM (default current UTC month) → per-feature calls/uses/cost
//   (sum, avg per use) and per-user totals, so pricing/limits can be checked against real numbers.
adminRouter.get("/ai-usage", async (c) => {
  const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? (c.req.query("month") as string) : new Date().toISOString().slice(0, 7);
  try {
    const out = await withDb(c.env, async (db) => {
      const col = db.collection(AI_USAGE);
      const byFeature = await col
        .aggregate([
          { $match: { month } },
          {
            $group: {
              _id: "$feature",
              requests: { $sum: 1 },
              countedUses: { $sum: { $cond: ["$counted", 1, 0] } },
              openrouterCalls: { $sum: "$calls" },
              costUsd: { $sum: "$costUsd" },
              maxCostUsd: { $max: "$costUsd" },
            },
          },
          { $addFields: { avgCostPerRequestUsd: { $divide: ["$costUsd", "$requests"] } } },
          { $sort: { costUsd: -1 } },
        ])
        .toArray();
      const byUser = await col
        .aggregate([
          { $match: { month } },
          { $group: { _id: "$userId", requests: { $sum: 1 }, costUsd: { $sum: "$costUsd" } } },
          { $sort: { costUsd: -1 } },
          { $limit: 50 },
        ])
        .toArray();
      return { month, byFeature, byUser };
    });
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] ai-usage report error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "ai-usage report failed" } } satisfies ApiResponse<never>, 502);
  }
});

adminRouter.post("/clerk-remap", async (c) => {
  const write = c.req.query("write") === "true";
  const input = (await c.req.json().catch(() => null)) as RemapInput | null;
  try {
    const out = await withDb(c.env, async (db) => {
      const plan = await planRemap(db, await resolvePairs(db, input ?? {}));
      if (!write) return { mode: "dry-run" as const, ...plan };
      if (plan.blockers.length) return { mode: "refused" as const, ...plan };
      return { mode: "write" as const, ...(await writeRemap(db, plan)) };
    });
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>, out.mode === "refused" ? 409 : 200);
  } catch (err) {
    return remapError(c, err, "clerk-remap");
  }
});

adminRouter.post("/clerk-remap/rollback", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  try {
    const out = await withDb(c.env, (db) => rollbackRemap(db, body?.batch ?? "", write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return remapError(c, err, "clerk-remap rollback");
  }
});

adminRouter.post("/clerk-remap/scratch-verify", async (c) => {
  const input = (await c.req.json().catch(() => null)) as RemapInput | null;
  try {
    const out = await scratchVerify(c.env, input ?? {});
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return remapError(c, err, "clerk-remap scratch-verify");
  }
});

// Delete a seed/test users row (Jackie 2026-10-20: delete test_clerk_id_1789421842). Only ids starting with
// "test_clerk_id_" are accepted; refused if any per-user collection still references the id. Default dry run;
// ?write=true copies the doc to clerk_remap_backups (batch "seeddelete_<id>") and then deletes it.
adminRouter.post("/users/delete-seed", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { clerkUserId?: string } | null;
  const id = body?.clerkUserId ?? "";
  if (!/^test_clerk_id_\d+$/.test(id)) return c.json({ ok: false, error: { code: "bad_request", message: "clerkUserId must match test_clerk_id_<digits>" } } satisfies ApiResponse<never>, 400);
  try {
    const out = await withDb(c.env, async (db) => {
      const docs = await db.collection("users").find({ clerkUserId: id }).toArray();
      const refs: Record<string, number> = {};
      for (const name of USERID_COLLECTIONS) {
        const n = await db.collection(name).countDocuments({ userId: id });
        if (n) refs[name] = n;
      }
      if (await db.collection("meal_plan_sequence").countDocuments({ _id: id as never })) refs.meal_plan_sequence = 1;
      const blocked = Object.keys(refs).length > 0;
      if (!write || blocked || docs.length !== 1) return { mode: blocked ? "refused" : "dry-run", found: docs.length, refs, deleted: 0 };
      await db.collection("clerk_remap_backups").insertOne({ batch: `seeddelete_${id}`, at: new Date(), collection: "users", docId: docs[0]!._id, doc: docs[0] });
      const r = await db.collection("users").deleteOne({ _id: docs[0]!._id, clerkUserId: id });
      const left = await db.collection("users").countDocuments({ clerkUserId: id });
      return { mode: "write", found: 1, refs, deleted: r.deletedCount, left };
    });
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return remapError(c, err, "users delete-seed");
  }
});

// Rollbacks (services/adminRollbacks.ts; Worker ports of scripts/price_refresh_rollback.cjs and
// scripts/recipe_cost_recompute_rollback.cjs). Dry run unless ?write=true.
//   POST /api/admin/price-refresh/rollback  body { batch, verifyRunId? } — for refresh-auto-* batches pass the runId:
//        every restored doc is checked against the run's pre-write snapshot and nothing is written on any mismatch.
//        Afterwards run POST /api/admin/recompute-costs (dry run first) so recipe_cost follows the restored prices.
//   POST /api/admin/recipe-cost/rollback    body { batch } — restores recipe_cost from costFixPrev (rcr-* batches).
function rollbackError(c: any, err: unknown, where: string) {
  if (err instanceof RollbackInputError) return c.json({ ok: false, error: { code: "bad_request", message: err.message } } satisfies ApiResponse<never>, 400);
  console.error(`[uiu-api] ${where} error:`, err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: { code: "db_error", message: `${where} failed` } } satisfies ApiResponse<never>, 502);
}

adminRouter.post("/price-refresh/rollback", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { batch?: string; verifyRunId?: string } | null;
  try {
    const out = await withDb(c.env, (db) => priceRefreshRollback(db, body?.batch ?? "", { write, verifyRunId: body?.verifyRunId ?? null }));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return rollbackError(c, err, "price-refresh rollback");
  }
});

adminRouter.post("/recipe-cost/rollback", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  try {
    const out = await withDb(c.env, (db) => recipeCostRollback(db, body?.batch ?? "", write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return rollbackError(c, err, "recipe-cost rollback");
  }
});

// Cloud-session -> Jackie Telegram notifications (dedicated bot, services/cloudNotify.ts).
//   POST /api/admin/notify/setup  — saves the chat id after Jackie has messaged the bot once.
//   POST /api/admin/notify        body { text } — sends a plain-text message.
function notifyError(c: any, err: unknown) {
  if (err instanceof NotifyError) return c.json({ ok: false, error: { code: "notify_error", message: err.message } } satisfies ApiResponse<never>, 400);
  console.error("[uiu-api] notify error:", err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: { code: "notify_error", message: "notify failed" } } satisfies ApiResponse<never>, 502);
}
adminRouter.post("/notify/setup", async (c) => {
  try {
    const out = await withDb(c.env, (db) => setupChat(c.env, db));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return notifyError(c, err);
  }
});
adminRouter.post("/notify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  if (!body?.text?.trim()) return c.json({ ok: false, error: { code: "bad_request", message: "text is required" } } satisfies ApiResponse<never>, 400);
  try {
    const out = await withDb(c.env, (db) => notify(c.env, db, body.text!));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return notifyError(c, err);
  }
});

// Fill per_item_g for common whole produce (services/perItemFill.ts). Dry run unless ?write=true; rollback by batch.
adminRouter.post("/canonical-per-item-fill", async (c) => {
  const write = c.req.query("write") === "true";
  const out = await withDb(c.env, (db): Promise<unknown> =>
    write ? writePerItemFill(db, `peritem_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${crypto.randomUUID().slice(0, 6)}`) : planPerItemFill(db).then((plan) => ({ dryRun: true, plan })),
  );
  return c.json({ ok: true, data: out });
});
adminRouter.post("/canonical-per-item-fill/rollback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  if (!body?.batch) return c.json({ ok: false, error: { code: "bad_request", message: "batch is required" } } satisfies ApiResponse<never>, 400);
  const out = await withDb(c.env, (db) => rollbackPerItemFill(db, body.batch!));
  return c.json({ ok: true, data: out });
});

// Read-only: why does a fridge item get / not get a £ value? (canonical match, per_item_g, price cache, normalizeQty)
adminRouter.get("/value-probe", async (c) => {
  const name = c.req.query("name") ?? "";
  const qty = Number(c.req.query("qty") ?? "1");
  const unit = c.req.query("unit") ?? "pc";
  const out = await withDb(c.env, async (db) => {
    const r = resolve(name, await buildAliasIndex(db.collection("canonical_ingredients")));
    const cn = "canonical_name" in r ? r.canonical_name : null;
    const canon = cn ? await db.collection("canonical_ingredients").findOne({ canonical_name: cn }, { projection: { canonical_name: 1, per_item_g: 1, category: 1 } }) : null;
    const price = cn ? await db.collection("canonical_price_cache").findOne({ canonical_name: cn }, { projection: { per_unit_metric: 1, per_unit_count: 1 } }) : null;
    return { resolve: r, canon, price, value: estimateValueWithCanonical(canon, price, qty, unit) };
  });
  return c.json({ ok: true, data: out });
});

// Admin image proxy — lets cloud's headless screenshot runs (welcome-page phone frames) load recipe photos,
// which the cloud sandbox can't fetch directly. Admin-token only; recipe image hosts only; read-only.
const IMAGE_PROXY_HOSTS = new Set(["images.pexels.com", "img.spoonacular.com", "www.themealdb.com"]);
adminRouter.get("/image-proxy", async (c) => {
  let target: URL;
  try {
    target = new URL(c.req.query("url") ?? "");
  } catch {
    return c.json({ ok: false, error: { code: "bad_request", message: "url is required" } } satisfies ApiResponse<never>, 400);
  }
  if (target.protocol !== "https:" || !IMAGE_PROXY_HOSTS.has(target.hostname)) {
    return c.json({ ok: false, error: { code: "forbidden_host", message: "host not allowed" } } satisfies ApiResponse<never>, 400);
  }
  const res = await fetch(target.toString());
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) {
    return c.json({ ok: false, error: { code: "upstream", message: `upstream ${res.status}` } } satisfies ApiResponse<never>, 502);
  }
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "no-store" } });
});

// Guest cleanup (services/guest.ts): deletes data of guest ids older than GUEST_TTL_DAYS. Dry run unless ?write=true.
// Also runs daily from scheduled() ("0 9 * * *").
adminRouter.post("/guest-cleanup", async (c) => {
  const write = c.req.query("write") === "true";
  try {
    const out = await withDb(c.env, (db) => cleanupExpiredGuests(db, write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] guest cleanup error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "guest cleanup failed" } } satisfies ApiResponse<never>, 502);
  }
});

// Use-it-up reminders: dry run by default (who would get one); ?write=true sends. Daily run: hourly cron at 17:00 UTC.
// POST /api/admin/push-test body { userId } sends one test push to that user's subscriptions.
adminRouter.post("/push-reminders", async (c) => {
  const write = c.req.query("write") === "true";
  try {
    const out = await withDb(c.env, (db) => sendExpiryReminders(c.env, db, !write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] push reminders error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "push_error", message: "push reminders failed" } } satisfies ApiResponse<never>, 502);
  }
});
adminRouter.post("/push-test", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { userId?: string } | null;
  if (!body?.userId) return c.json({ ok: false, error: { code: "bad_request", message: "userId is required" } } satisfies ApiResponse<never>, 400);
  try {
    const subs = await withDb(c.env, (db) => db.collection(PUSH_SUBSCRIPTIONS).find({ userId: body.userId }).toArray());
    const statuses: number[] = [];
    for (const s of subs) statuses.push(await sendPush(c.env, String(s.endpoint)).catch(() => -1));
    return c.json({ ok: true, data: { subscriptions: subs.length, statuses } });
  } catch (err) {
    return c.json({ ok: false, error: { code: "push_error", message: err instanceof Error ? err.message : "push test failed" } } satisfies ApiResponse<never>, 502);
  }
});

// DEL (privacy policy: "delete your data within 30 days"): erase every per-user doc for one user.
//   POST /api/admin/users/delete-data  body { clerkUserId } or { email } — dry run (counts per collection).
//   ?write=true also needs body.confirm === the resolved clerkUserId. No backup is kept on purpose (it is an erasure
//   request). The Clerk account itself is deleted separately in the Clerk dashboard.
adminRouter.post("/users/delete-data", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { clerkUserId?: string; email?: string; confirm?: string } | null;
  try {
    const out = await withDb(c.env, async (db) => {
      let userId = body?.clerkUserId ?? null;
      if (!userId && body?.email) {
        const docs = await db.collection("users").find({ email: { $regex: `^${body.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }).toArray();
        if (docs.length !== 1) return { error: `expected exactly 1 users doc for that email, found ${docs.length}` };
        userId = String(docs[0]!.clerkUserId);
      }
      if (!userId || !/^[A-Za-z0-9_]+$/.test(userId)) return { error: "give clerkUserId or email" };
      const counts: Record<string, number> = {};
      const targets: [string, Record<string, unknown>][] = [
        ...USERID_COLLECTIONS.map((n) => [n, { userId }] as [string, Record<string, unknown>]),
        ["meal_plan_sequence", { _id: userId }],
        ["users", { clerkUserId: userId }],
        [PUSH_SUBSCRIPTIONS, { userId }],
        ["scan_errors", { userId }],
        // Private user recipes (imports / manual saves, 2026-10-27) + their cost docs.
        ["recipes", { clerkUserId: userId, isPublic: { $ne: true } }],
      ];
      const ownRecipeIds = (await db.collection("recipes").find({ clerkUserId: userId, isPublic: { $ne: true } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
      targets.push(["recipe_cost", { recipeId: { $in: ownRecipeIds } }]);
      for (const [name, filter] of targets) {
        const n = await db.collection(name).countDocuments(filter as never);
        if (n) counts[name] = n;
      }
      if (!write) return { mode: "dry-run", userId, counts };
      if (body?.confirm !== userId) return { error: "write needs confirm = the clerkUserId shown by the dry run" };
      const deleted: Record<string, number> = {};
      for (const [name, filter] of targets) {
        const r = await db.collection(name).deleteMany(filter as never);
        if (r.deletedCount) deleted[name] = r.deletedCount;
      }
      let left = 0;
      for (const [name, filter] of targets) left += await db.collection(name).countDocuments(filter as never);
      return { mode: "write", userId, deleted, left };
    });
    if ("error" in out) return c.json({ ok: false, error: { code: "bad_request", message: String(out.error) } } satisfies ApiResponse<never>, 400);
    return c.json({ ok: true, data: out });
  } catch (err) {
    console.error("[uiu-api] delete-data error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "delete-data failed" } } satisfies ApiResponse<never>, 502);
  }
});

// Receipt-scan debugging (Jackie 2026-10-26: "Failed to analyze image" on a real receipt).
//   POST /api/admin/vision-test  multipart { image } — runs the exact /api/fridge-stock/ocr scan and returns the
//   result, or the real failure reason + timing instead of the generic user-facing message. Writes nothing.
adminRouter.post("/vision-test", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.image;
  if (!(file instanceof File)) return c.json({ ok: false, error: { code: "bad_request", message: "multipart 'image' file required" } } satisfies ApiResponse<never>, 400);
  const model = c.req.query("model") || undefined;
  const t0 = Date.now();
  try {
    const data = await scanFile(c.env, file, RECEIPT_PROMPT, model);
    return c.json({ ok: true, data: { ms: Date.now() - t0, bytes: file.size, type: file.type, model: model ?? c.env.OPENROUTER_RECEIPT_MODEL ?? c.env.OPENROUTER_VISION_MODEL, ...data } });
  } catch (err) {
    const kind = err && typeof err === "object" && "kind" in err ? String((err as { kind: unknown }).kind) : "other";
    return c.json({ ok: false, error: { code: `vision_${kind}`, message: err instanceof Error ? err.message : String(err) }, ms: Date.now() - t0, bytes: file.size, type: file.type });
  }
});

// Video-import debugging (Jackie 2026-10-27: "couldn't find a recipe in this video"). Multipart { video }; writes nothing.
//   ?model=<openrouter model id> overrides the vision model for a comparison.
adminRouter.post("/video-test", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.video;
  if (!(file instanceof File)) return c.json({ ok: false, error: { code: "bad_request", message: "multipart 'video' file required" } } satisfies ApiResponse<never>, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const mime = file.type && file.type !== "application/octet-stream" ? file.type : "video/mp4";
  const dataUrl = `data:${mime};base64,${btoa(parts.join(""))}`;
  const t0 = Date.now();
  try {
    const out = await diagnoseVideoRecipe(c.env, dataUrl, c.req.query("model") || undefined);
    return c.json({ ok: true, data: { ms: Date.now() - t0, bytes: file.size, mime, ...out } });
  } catch (err) {
    return c.json({ ok: false, error: { code: "video_test", message: err instanceof Error ? err.message : String(err) }, ms: Date.now() - t0 });
  }
});

// Video transcription test (2026-10-27): speech + on-screen text only. ?model= overrides. Writes nothing.
adminRouter.post("/video-transcribe-test", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.video;
  if (!(file instanceof File)) return c.json({ ok: false, error: { code: "bad_request", message: "multipart 'video' file required" } } satisfies ApiResponse<never>, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const dataUrl = `data:${file.type || "video/mp4"};base64,${btoa(parts.join(""))}`;
  const t0 = Date.now();
  const out = await transcribeVideo(c.env, dataUrl, c.req.query("model") || undefined);
  return c.json({ ok: out.ok, data: { ms: Date.now() - t0, model: c.req.query("model") || c.env.OPENROUTER_VIDEO_MODEL || c.env.OPENROUTER_VISION_MODEL, ...out } });
});

// Two-step video import test (2026-10-27): transcribe (?transcribeModel=, default flash) → existing text parser.
adminRouter.post("/video-recipe-test", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.video;
  if (!(file instanceof File)) return c.json({ ok: false, error: { code: "bad_request", message: "multipart 'video' file required" } } satisfies ApiResponse<never>, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const dataUrl = `data:${file.type || "video/mp4"};base64,${btoa(parts.join(""))}`;
  const t0 = Date.now();
  const tr = await transcribeVideo(c.env, dataUrl, c.req.query("transcribeModel") || "google/gemini-2.5-flash");
  const t1 = Date.now();
  if (!tr.ok) return c.json({ ok: false, stage: "transcribe", status: tr.status, body: tr.text, ms: t1 - t0 });
  const dbg: { raw?: string; reason?: string } = {};
  const recipe = await parseRecipeFromText(c.env, tr.text, dbg);
  return c.json({
    ok: true,
    data: {
      transcribeMs: t1 - t0,
      parseMs: Date.now() - t1,
      transcriptChars: tr.text.length,
      transcript: tr.text,
      parserReason: dbg.reason ?? null,
      parserRaw: (dbg.raw ?? "").slice(0, 3000),
      recipe: recipe
        ? { title: recipe.title, ingredients: recipe.ingredients.length, steps: recipe.steps.length, ingredientList: recipe.ingredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`.trim()), stepsList: recipe.steps }
        : null,
    },
  });
});

// Recent photo/receipt scan failures written by /api/fridge-stock/ocr and /scan-fridge (no images stored).
adminRouter.get("/scan-errors", async (c) => {
  try {
    const docs = await withDb(c.env, (db) => db.collection("scan_errors").find({}).sort({ at: -1 }).limit(20).toArray());
    return c.json({ ok: true, data: docs.map((d) => ({ ...d, _id: String(d._id) })) });
  } catch (err) {
    console.error("[uiu-api] scan-errors error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "scan-errors failed" } } satisfies ApiResponse<never>, 502);
  }
});

// TheMealDB publish review (services/publishCandidates.ts) — read-only dry run, writes nothing.
adminRouter.get("/recipes-publish-review", async (c) => {
  const source = c.req.query("source") ?? "themealdb";
  try {
    const out = await withDb(c.env, (db) => reviewPublishCandidates(db, source));
    return c.json({ ok: true, data: out });
  } catch (err) {
    console.error("[uiu-api] publish review error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "publish review failed" } } satisfies ApiResponse<never>, 502);
  }
});

// Guarded price refresh (cc_prompt_price_refresh_monthly_cron.md Part 4). Opens a run and processes the first batch.
//   ?dryRun=true|false  — default TRUE. dryRun=false is refused unless PRICE_REFRESH_AUTO_WRITE="true" (the one kill-switch).
//   ?names=a,b,c / ?limit=N  — testing only, dryRun=true only: restrict the run to those eligible canonicals / first N eligible.
//   ?notify=false  — suppress the Telegram summary (local testing).
// The remaining batches are fetched by the "15 * * * *" cron (<= 25 docs per fire); POST /api/admin/price-refresh/step
// processes one more batch by hand; GET /api/admin/price-refresh[?runId=&results=true] reads a run doc.
adminRouter.post("/price-refresh", async (c) => {
  const dryRun = c.req.query("dryRun") !== "false";
  const names = (c.req.query("names") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limited = names.length > 0 || Number.isFinite(limit);
  if (limited && !dryRun) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "names/limit are only allowed with dryRun=true" } };
    return c.json(body, 400);
  }
  const env = c.req.query("notify") === "false" ? { ...c.env, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } : c.env;
  try {
    const r = await openManualRun(env, { dryRun, names: names.length ? names : undefined, limit: Number.isFinite(limit) ? limit : undefined });
    if (!r.open.opened) {
      const code = r.open.reason === "active_run" ? 409 : r.open.reason === "write_disabled" ? 403 : 422;
      const body: ApiResponse<never> = { ok: false, error: { code: r.open.reason, message: JSON.stringify(r.open) } };
      return c.json(body, code);
    }
    return c.json({ ok: true, data: r });
  } catch (err) {
    console.error("[uiu-api] price-refresh error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "price_refresh_error", message: err instanceof Error ? err.message : String(err) } };
    return c.json(body, 502);
  }
});
adminRouter.post("/price-refresh/step", async (c) => {
  try {
    return c.json({ ok: true, data: await processPriceRefresh(c.env) });
  } catch (err) {
    const body: ApiResponse<never> = { ok: false, error: { code: "price_refresh_error", message: err instanceof Error ? err.message : String(err) } };
    return c.json(body, 502);
  }
});
adminRouter.get("/price-refresh", async (c) => {
  try {
    const run = await getRun(c.env, c.req.query("runId") ?? null, c.req.query("results") === "true");
    return c.json({ ok: true, data: run });
  } catch (err) {
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: err instanceof Error ? err.message : String(err) } };
    return c.json(body, 502);
  }
});

// Price-refresh override list (services/priceRefreshOverrides.ts). A canonical with an override row is never refreshed
// (keep_old / skip), so its price goes stale. Dry run unless ?write=true; remove returns the rows so they can be re-added.
//   GET  /api/admin/price-refresh/overrides                    list every override + the date of its current price
//   POST /api/admin/price-refresh/overrides/remove  body { names: ["mango"] }                          (max 10 names)
//   POST /api/admin/price-refresh/overrides/add     body { name, decision: "keep_old"|"skip", note? }  (undo of remove)
// Removing a row writes no price — the canonical just becomes eligible for the next refresh run / ?names= dry run.
function overrideError(c: any, err: unknown, where: string) {
  if (err instanceof OverrideInputError) return c.json({ ok: false, error: { code: "bad_request", message: err.message } } satisfies ApiResponse<never>, 400);
  console.error(`[uiu-api] ${where} error:`, err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: { code: "db_error", message: `${where} failed` } } satisfies ApiResponse<never>, 502);
}
adminRouter.get("/price-refresh/overrides", async (c) => {
  try {
    const out = await withDb(c.env, (db) => listOverrides(db));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return overrideError(c, err, "price-refresh overrides list");
  }
});
adminRouter.post("/price-refresh/overrides/remove", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { names?: unknown } | null;
  try {
    const out = await withDb(c.env, (db) => removeOverrides(db, body?.names, write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return overrideError(c, err, "price-refresh overrides remove");
  }
});
adminRouter.post("/price-refresh/overrides/add", async (c) => {
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; decision?: unknown; note?: unknown } | null;
  try {
    const out = await withDb(c.env, (db) => addOverride(db, body, write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return overrideError(c, err, "price-refresh overrides add");
  }
});

// Post-populate sanity check — lets Jackie confirm a write landed without
// opening the Atlas UI. Same auth as the route above.
adminRouter.get("/recipe-cost-stats", async (c) => {
  try {
    const stats = await recipeCostStats(c.env);
    const body: ApiResponse<RecipeCostStats> = { ok: true, data: stats };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recipe-cost-stats error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to read recipe_cost stats" } };
    return c.json(body, 502);
  }
});

// Manual trigger for the PWA diagnostics cron (HANDOFF_pwa-diagnostics-monitor.md
// verification requirements). Real Telegram sends happen here too — this IS the
// dry-run mechanism (there's no separate "fake" mode), so use it deliberately.
//   ?forceAlert=true   — bypass the issue-set-unchanged/cooldown dedup, useful when
//                        testing a deliberately-lowered coverage threshold.
//   ?forceDigest=true  — bypass the "is it 10am UK" gate, sends the OpenRouter summary now.
adminRouter.post("/pwa-diagnostics-run", async (c) => {
  try {
    const result = await runDiagnostics(c.env, {
      forceAlert: c.req.query("forceAlert") === "true",
      forceDigest: c.req.query("forceDigest") === "true",
    });
    const body: ApiResponse<DiagnosticsRunResult> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] pwa-diagnostics-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Diagnostics run failed" } };
    return c.json(body, 502);
  }
});

// Sends a fixed test message — confirms the Telegram secrets/bot/chat are
// wired correctly without touching diagnostics state or coverage checks.
adminRouter.post("/pwa-diagnostics-test-telegram", async (c) => {
  try {
    await sendTelegram(c.env, "🔧 UIU PWA diagnostics — test message. If you can read this, the bot/chat wiring works.");
    const body: ApiResponse<{ sent: true }> = { ok: true, data: { sent: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] pwa-diagnostics-test-telegram error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "telegram_error", message: "Failed to send Telegram test message" } };
    return c.json(body, 502);
  }
});

// Manual trigger for the IG Content Agent organic batch (HANDOFF_ig-marketing-affiliate-agent-design.md
// §3; cc_prompt_affiliate_cadence.md, 2026-09-02 — organic-only now, IG_CONTENT_BATCH_SIZE drafts
// per call, Jackie fires this herself). Sends each to the IG review Telegram chat with
// Approve/Reject buttons. There is no dry-run flag here: every draft is real content sent
// for review, but nothing gets published to Instagram until a human taps Approve.
adminRouter.post("/ig-content-batch-run", async (c) => {
  try {
    const summary = await runIgContentBatch(c.env);
    const body: ApiResponse<BatchSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-content-batch-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "IG content batch run failed" } };
    return c.json(body, 502);
  }
});

// cc_prompt_affiliate_cadence.md, 2026-09-02 — on-demand trigger for the affiliate cron logic
// (normally fires from scheduled() at "0 8 * * *"). Exists so the calendar-day gate can be
// verified without waiting 3 real days: fire this repeatedly and read `ran`/`reason` back.
adminRouter.post("/ig-affiliate-cron-run", async (c) => {
  try {
    const result = await runAffiliateCron(c.env);
    const body: ApiResponse<{ ran: boolean; reason: string; daysSinceLast: number | null; draftId: string | null }> = {
      ok: true,
      data: { ...result, draftId: result.draftId ? result.draftId.toHexString() : null },
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-affiliate-cron-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Affiliate cron run failed" } };
    return c.json(body, 502);
  }
});

// cc_prompt_ig_insights_tracking.md, 2026-09-07 — on-demand trigger for the insights snapshot
// cron (normally fires from scheduled() at "30 * * * *"). Exists so the 24h/7d windows can be
// verified without waiting for the real clock — fire this against a draft whose publishedAt is
// already >=24h/>=7d in the past and read the summary counts back.
adminRouter.post("/ig-insights-cron-run", async (c) => {
  try {
    const result = await runInsightsSnapshotCron(c.env);
    const body: ApiResponse<typeof result> = { ok: true, data: result };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-insights-cron-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Insights cron run failed" } };
    return c.json(body, 502);
  }
});

// Manual trigger for a multi-product collage post (cc_prompt_multiproduct_collage.md, 2026-09-01)
// — groups 9 same-theme affiliate products into one catalog-grid image driving traffic to
// useitup.uk/shop-affiliate. Manual-trigger only for V1 (confirmed with Jackie): not wired into
// the runIgContentBatch cron interleave.
adminRouter.post("/ig-content/collage", async (c) => {
  try {
    const draftId = await generateAndSendCollage(c.env);
    const body: ApiResponse<{ draftId: string | null }> = { ok: true, data: { draftId: draftId ? draftId.toHexString() : null } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-content-collage error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "IG content collage run failed" } };
    return c.json(body, 502);
  }
});

// Renders a collage PNG straight from a supplied product list and returns the raw image —
// no Mongo write, no Telegram send. cc_prompt_multiproduct_collage.md's 2026-09-02 moodboard
// redesign asked for local sample renders before wide rollout; this route is the repeatable way
// to get those (curl it with a real product/theme payload, save the response body as a .png)
// without spamming the review chat for every layout tweak.
adminRouter.post("/ig-content/collage-preview", async (c) => {
  try {
    const payload = await c.req.json<{ headline: string; subtitle: string; products: Array<{ imageUrl: string; productName: string; benefitLine: string }> }>();
    const png = await renderCollageImage(payload);
    return new Response(png, { headers: { "content-type": "image/png" } });
  } catch (err) {
    console.error("[uiu-api] ig-content collage-preview error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "Collage preview render failed" } };
    return c.json(body, 502);
  }
});

// Manual trigger for the IG token health check — confirms the Telegram alert path works
// and lets Jackie check expiry on demand without waiting for the cron.
adminRouter.post("/ig-token-health-run", async (c) => {
  try {
    await checkIgTokenHealth(c.env);
    const body: ApiResponse<{ checked: true }> = { ok: true, data: { checked: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] ig-token-health-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "internal_error", message: "IG token health check failed" } };
    return c.json(body, 502);
  }
});
