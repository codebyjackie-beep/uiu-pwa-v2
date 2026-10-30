import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_VERSION, type ApiResponse, type HealthCheck } from "@uiu/shared";
import { guestForbidden, requireClerkAuth, requireUser } from "./clerkAuth";
import { requireAdmin } from "./adminAuth";
import { recipesRouter } from "./routes/recipes";
import { mealPlanRouter } from "./routes/mealPlan";
import { mealPlanSetsRouter } from "./routes/mealPlanSets";
import { adminRecipeDraftsRouter } from "./routes/adminRecipeDrafts";
import { adminVideoImportTestRouter } from "./routes/adminVideoImportTest";
import { adminRecipesRouter } from "./routes/adminRecipes";
import { fridgeStockRouter } from "./routes/fridgeStock";
import { mealSuggestionsRouter } from "./routes/mealSuggestions";
import { favouriteRecipesRouter } from "./routes/favouriteRecipes";
import { shopRouter } from "./routes/shop";
import { shoppingListRouter } from "./routes/shoppingList";
import { healthRouter } from "./routes/health";
import { recipeImportRouter } from "./routes/recipeImport";
import { fridgeRecipeGenRouter } from "./routes/fridgeRecipeGen";
import { recipeBrowseStateRouter } from "./routes/recipeBrowseState";
import { precomputeRecipeCosts } from "./jobs/precomputeRecipeCosts";
import { anomalyAlertText } from "./jobs/recipeCostGate";
import { dailyRecipeDraft } from "./jobs/dailyRecipeDraft";
import { runDiagnostics } from "./jobs/pwaDiagnostics";
import { sendTelegram } from "./services/telegram";
import { runAffiliateCron } from "./jobs/igContentAgent";
import { checkIgTokenHealth } from "./jobs/igTokenHealth";
import { runInsightsSnapshotCron } from "./jobs/igInsights";
import { igWebhookRouter } from "./routes/igWebhook";
import { adminIgDraftsRouter } from "./routes/adminIgDrafts";
import { affiliateProductsRouter } from "./routes/affiliateProducts";
import { usersRouter } from "./routes/users";
import { billingRouter } from "./routes/billing";
import { igMediaRouter } from "./routes/igMedia";
import { recordCronRun } from "./services/cronHealthMonitor";
import { withDb } from "./db";
import { PUSH_SUBSCRIPTIONS, saveSubscription, sendExpiryReminders, validSubscription, type PushSubscriptionInput } from "./services/webPush";
import { claimGuestData, cleanupExpiredGuests, mintGuestToken, verifyGuestToken } from "./services/guest";
import { maybeStartScheduledRun, processPriceRefresh } from "./jobs/priceRefresh";
import { getMyPlan, installOpenRouterMeter, premiumGate, type PremiumEnv } from "./services/premium";
import type { PremiumFeature } from "@uiu/shared";
import type { Bindings } from "./bindings";
import { adminRouter } from "./routes/admin";

// Milestone 3: per-request OpenRouter cost capture for the Premium usage meter (services/premium.ts).
installOpenRouterMeter();

const app = new Hono<{ Bindings: Bindings }>();

// Same-origin in production (web + api both on Cloudflare). CORS is permissive here only
// to keep local `wrangler dev` + `next dev` on separate ports talking during development.
app.use("*", cors());

// M2: every per-user route requires a verified Clerk session — apps/api has its own public
// workers.dev URL, so the web layer alone is not a gate. userId is taken from the token `sub` only.
for (const path of [
  "/api/meal-plan",
  "/api/meal-plan/*",
  "/api/meal-plan-sets",
  "/api/meal-plan-sets/*",
  "/api/fridge-stock",
  "/api/fridge-stock/*",
  "/api/meal-suggestions",
  "/api/meal-suggestions/*",
  "/api/favourite-recipes",
  "/api/favourite-recipes/*",
  "/api/shop",
  "/api/shop/*",
  "/api/shopping-list",
  "/api/shopping-list/*",
  "/api/health/*",
  "/api/recipe-browse",
  "/api/recipe-browse/*",
  "/api/recipes/generate-from-fridge",
  "/api/recipes/save-fridge-recipe",
  // from-url / from-text / from-photo call OpenRouter (paid) — never open to anonymous callers.
  "/api/recipe-import",
  "/api/recipe-import/*",
]) {
  // Guest mode: a Clerk session OR a guest token (requireUser); Premium routes below refuse guests.
  app.use(path, requireUser);
}

// Premium functions (Jackie 2026-10-20) — guests get 403 guest_forbidden. Free signed-in users are not gated
// until Stripe (Milestone 3).
for (const [method, path] of [
  ["POST", "/api/meal-plan/generate"], // AI meal plan wizard
  ["POST", "/api/health/coach"], // AI Nutrition Coach
  ["POST", "/api/health/meal-logs"], // meal photo -> vision estimate
  ["POST", "/api/health/meal-logs/barcode"], // barcode scan
  ["POST", "/api/fridge-stock/ocr"], // receipt scan
  ["POST", "/api/fridge-stock/scan-fridge"], // fridge photo
  ["POST", "/api/recipes/generate-from-fridge"], // fridge -> recipe
  ["POST", "/api/recipes/save-fridge-recipe"],
  ["ALL", "/api/recipe-import/*"], // recipe import (link / text / photo)
] as const) {
  app.on(method === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : [method], path, guestForbidden);
}

// Milestone 3 (Jackie 2026-10-28): plan + monthly limits per feature (services/premium.ts). Runs after
// guestForbidden. PREMIUM_ENFORCE != "true" → never blocks, only records usage + OpenRouter cost.
for (const [path, feature] of [
  ["/api/recipe-import/from-video", "video_import"],
  ["/api/fridge-stock/ocr", "receipt_scan"],
  ["/api/health/coach", "coach"],
  ["/api/recipes/generate-from-fridge", "fridge_recipe"],
  ["/api/health/meal-logs", "ai_other"],
  ["/api/fridge-stock/scan-fridge", "ai_other"],
  ["/api/recipe-import/from-url", "ai_other"],
  ["/api/recipe-import/from-text", "ai_other"],
  ["/api/recipe-import/from-photo", "ai_other"],
  ["/api/meal-plan/generate", "meal_plan_wizard"],
  ["/api/health/meal-logs/barcode", "barcode"],
] as const satisfies readonly (readonly [string, PremiumFeature])[]) {
  app.post(path, premiumGate(feature) as never);
}

app.get("/api/me/plan", requireUser, async (c) => {
  if (c.get("isGuest")) {
    return c.json({ ok: false, error: { code: "guest_forbidden", message: "Sign up free to see your plan" } }, 403);
  }
  try {
    const data = await getMyPlan(c.env as unknown as PremiumEnv, c.get("clerkUserId"));
    return c.json({ ok: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    console.error("[uiu-api] me/plan error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "Failed to load plan" } } satisfies ApiResponse<never>, 502);
  }
});

// Use-it-up push reminders (services/webPush.ts). Signed-in users only (guests get guest_forbidden).
app.get("/api/push/public-key", (c) => c.json({ ok: true, data: { publicKey: c.env.VAPID_PUBLIC_KEY ?? null } }));
app.post("/api/push/subscribe", requireUser, guestForbidden, async (c) => {
  const body = (await c.req.json().catch(() => null)) as PushSubscriptionInput | null;
  if (!validSubscription(body)) return c.json({ ok: false, error: { code: "bad_request", message: "invalid push subscription" } } satisfies ApiResponse<never>, 400);
  try {
    await withDb(c.env, (db) => saveSubscription(db, c.get("clerkUserId"), body));
    return c.json({ ok: true, data: { subscribed: true } });
  } catch (err) {
    console.error("[uiu-api] push subscribe error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "subscribe failed" } } satisfies ApiResponse<never>, 502);
  }
});
app.post("/api/push/unsubscribe", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) return c.json({ ok: false, error: { code: "bad_request", message: "endpoint is required" } } satisfies ApiResponse<never>, 400);
  try {
    const r = await withDb(c.env, (db) => db.collection(PUSH_SUBSCRIPTIONS).deleteOne({ endpoint: body.endpoint, userId: c.get("clerkUserId") }));
    return c.json({ ok: true, data: { removed: r.deletedCount } });
  } catch {
    return c.json({ ok: false, error: { code: "db_error", message: "unsubscribe failed" } } satisfies ApiResponse<never>, 502);
  }
});

// Guest mode: mint a stateless guest token (no DB write), and claim a guest's data into a freshly signed-up account.
app.post("/api/guest/session", async (c) => {
  const out = await mintGuestToken(c.env.ADMIN_TOKEN);
  return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
});
app.post("/api/guest/claim", requireClerkAuth, async (c) => {
  const guestId = await verifyGuestToken(c.env.ADMIN_TOKEN, c.req.header("X-Guest-Token"));
  if (!guestId) return c.json({ ok: true, data: { claimed: false, reason: "no_valid_guest_token", moved: {} } });
  try {
    const out = await withDb(c.env, (db) => claimGuestData(db, guestId, c.get("clerkUserId")));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] guest claim error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "claim failed" } } satisfies ApiResponse<never>, 502);
  }
});

app.get("/health", (c) => {
  const body: ApiResponse<HealthCheck> = {
    ok: true,
    data: {
      status: "ok",
      service: "uiu-api",
      version: API_VERSION,
      time: new Date().toISOString(),
    },
  };
  return c.json(body);
});

app.get("/api/version", (c) => {
  const body: ApiResponse<{ version: string; env: string }> = {
    ok: true,
    data: { version: API_VERSION, env: c.env.API_ENV ?? "unknown" },
  };
  return c.json(body);
});

// Every /api/admin/* route (inline below + admin sub-routers) needs X-Admin-Token — one gate, not 53 copies.
app.use("/api/admin/*", requireAdmin);

app.route("/api/recipes", recipesRouter);
app.route("/api/recipes", fridgeRecipeGenRouter);
app.route("/api/meal-plan", mealPlanRouter);
app.route("/api/meal-plan-sets", mealPlanSetsRouter);
app.route("/api/admin/recipe-drafts", adminRecipeDraftsRouter);
app.route("/api/admin/video-import-test", adminVideoImportTestRouter);
app.route("/api/admin/recipes", adminRecipesRouter);
app.route("/api/fridge-stock", fridgeStockRouter);
app.route("/api/meal-suggestions", mealSuggestionsRouter);
app.route("/api/favourite-recipes", favouriteRecipesRouter);
app.route("/api/shop", shopRouter);
app.route("/api/shopping-list", shoppingListRouter);
app.route("/api/users", usersRouter);
// Milestone 3 Phase B (Jackie 2026-10-28): Stripe Checkout / Portal / webhook (routes/billing.ts). Webhook is
// signature-verified inside the router, so it is intentionally not behind requireUser.
app.route("/api/billing", billingRouter);
app.route("/api/health", healthRouter);
app.route("/api/recipe-import", recipeImportRouter);
app.route("/api/recipe-browse", recipeBrowseStateRouter);
app.route("/api/ig-webhook", igWebhookRouter);
app.route("/api/admin/ig-drafts", adminIgDraftsRouter);
app.route("/api/admin", adminRouter); // inline admin endpoints (routes/admin.ts)
app.route("/api/affiliate-products", affiliateProductsRouter);
app.route("/api/ig-media", igMediaRouter);

app.notFound((c) => {
  const body: ApiResponse<never> = {
    ok: false,
    error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` },
  };
  return c.json(body, 404);
});

app.onError((err, c) => {
  // NOTE: never log request bodies / health data here — secret-tier.
  console.error("[uiu-api] unhandled error:", err.message);
  const body: ApiResponse<never> = {
    ok: false,
    error: { code: "internal_error", message: "Internal error" },
  };
  return c.json(body, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Cron Trigger handler — branches on event.cron since two
   * independent jobs now share this Worker (weekly cost recompute vs. the
   * daily recipe draft agent). Keep the two logics separate, not merged.
   */
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === "0 * * * *") {
      // Use-it-up push reminders once a day at 17:00 UTC (18:00 BST / 17:00 GMT).
      if (new Date(event.scheduledTime).getUTCHours() === 17) {
        ctx.waitUntil(
          withDb(env, (db) => sendExpiryReminders(env, db, false))
            .then((r) => console.log("[uiu-api] cron pushReminders:", JSON.stringify(r)))
            .catch((err) => console.error("[uiu-api] cron pushReminders failed:", err instanceof Error ? err.message : String(err))),
        );
      }
      ctx.waitUntil(
        runDiagnostics(env)
          .then((result) => {
            console.log("[uiu-api] cron pwaDiagnostics:", JSON.stringify({ brokenIssues: result.brokenIssues, alertSent: result.alertSent, digestSent: result.digestSent }));
            return recordCronRun(env, { jobName: "pwaDiagnostics", ok: true, itemsProcessed: result.checks.length }).catch(() => {});
          })
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error("[uiu-api] cron pwaDiagnostics failed:", errorMessage);
            return recordCronRun(env, { jobName: "pwaDiagnostics", ok: false, errorMessage }).catch(() => {});
          }),
      );
      return;
    }
    if (event.cron === "0 9 * * *") {
      // cc_prompt_affiliate_cadence.md, 2026-09-02: organic generation moved to manual-trigger-only
      // (POST /api/admin/ig-content-batch-run, Jackie fires it herself) — this fire is now JUST the
      // IG token expiry check. Kept on its own long-standing schedule rather than folding into the
      // new affiliate cron below so retiming one doesn't retime the other.
      if (env.IG_AUTOMATION_PAUSED !== "true") ctx.waitUntil(
        checkIgTokenHealth(env).catch((err) => {
          console.error("[uiu-api] cron igTokenHealth failed:", err instanceof Error ? err.message : String(err));
        }),
      );
      // Guest mode: daily delete of guest data older than 7 days (services/guest.ts).
      ctx.waitUntil(
        withDb(env, (db) => cleanupExpiredGuests(db, true))
          .then((r) => console.log("[uiu-api] cron guestCleanup:", JSON.stringify(r)))
          .catch((err) => console.error("[uiu-api] cron guestCleanup failed:", err instanceof Error ? err.message : String(err))),
      );
      return;
    }
    if (event.cron === "0 8 * * *") {
      if (env.IG_AUTOMATION_PAUSED === "true") return console.log("[uiu-api] cron affiliateCadence skipped: IG_AUTOMATION_PAUSED");
      // cc_prompt_affiliate_cadence.md, 2026-09-02 — daily fire, but runAffiliateCron only
      // actually generates once every 3 calendar days (see its own comment); other fires are a
      // cheap no-op (one Mongo read). 08:00 UTC = UK morning, deliberately ahead of the 09:00
      // token-health fire and clear of dailyRecipeDraft's 07/10 slots.
      ctx.waitUntil(
        runAffiliateCron(env)
          .then((result) => {
            console.log("[uiu-api] cron affiliateCadence:", JSON.stringify(result));
            return recordCronRun(env, {
              jobName: "affiliateCadence",
              ok: true,
              itemsProcessed: result.ran ? 1 : 0,
            }).catch(() => {});
          })
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error("[uiu-api] cron affiliateCadence failed:", errorMessage);
            return recordCronRun(env, { jobName: "affiliateCadence", ok: false, errorMessage }).catch(() => {});
          }),
      );
      return;
    }
    if (event.cron === "30 * * * *") {
      if (env.IG_AUTOMATION_PAUSED === "true") return console.log("[uiu-api] cron igInsights skipped: IG_AUTOMATION_PAUSED");
      // cc_prompt_ig_insights_tracking.md, 2026-09-07 — hourly, offset 30min from the diagnostics
      // cron so the two never fire in the same invocation. Each fire is a cheap no-op for drafts
      // whose 24h/7d window hasn't arrived yet or was already fetched (see runInsightsSnapshotCron's
      // query filter).
      ctx.waitUntil(
        runInsightsSnapshotCron(env)
          .then((result) => {
            console.log("[uiu-api] cron igInsights:", JSON.stringify(result));
            return recordCronRun(env, { jobName: "igInsights", ok: true, itemsProcessed: result.fetched24h + result.fetched7d }).catch(() => {});
          })
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error("[uiu-api] cron igInsights failed:", errorMessage);
            return recordCronRun(env, { jobName: "igInsights", ok: false, errorMessage }).catch(() => {});
          }),
      );
      return;
    }
    if (event.cron === "15 * * * *") {
      // cc_prompt_price_refresh_monthly_cron.md — hourly price-refresh worker. No active run => one Mongo read and out. With an active
      // run it fetches <= PRICE_REFRESH_DOCS_PER_FIRE (25) docs; the last fire decides (+ writes only if PRICE_REFRESH_AUTO_WRITE="true").
      // Deliberately NOT in cronHealthMonitor's MonitoredJobName: the idle fires would look like "ran with 0 items" all month.
      // The daily schedule needs a kick-off on non-Mondays too, so the 03:xx fire tries to open the day's run (idempotent per slot).
      ctx.waitUntil(
        (async () => {
          if (env.PRICE_REFRESH_SCHEDULE === "daily" && new Date().getUTCHours() === 3) {
            console.log("[uiu-api] cron priceRefresh daily kick-off:", JSON.stringify(await maybeStartScheduledRun(env)));
          }
          console.log("[uiu-api] cron priceRefresh:", JSON.stringify(await processPriceRefresh(env)));
        })().catch((err) => {
          console.error("[uiu-api] cron priceRefresh failed:", err instanceof Error ? err.message : String(err));
        }),
      );
      return;
    }
    if (event.cron === "0 7 * * *") {
      ctx.waitUntil(
        dailyRecipeDraft(env, false)
          .then((summary) => {
            console.log("[uiu-api] cron dailyRecipeDraft:", JSON.stringify({ created: summary.created, skippedDuplicates: summary.skippedDuplicates, batch: summary.batch }));
            // Same "resolves normally with zero output" risk as igContentAgent — each spec's
            // OpenRouter/Spoonacular calls are caught per-attempt inside dailyRecipeDraft, so a
            // billing/API outage shows up as created:0 here, not a rejection.
            const ok = summary.batch.alreadyCompletedToday || summary.batch.attempted === 0 || summary.created > 0;
            return recordCronRun(env, {
              jobName: "dailyRecipeDraft",
              ok,
              itemsProcessed: summary.created,
              errorMessage: ok ? undefined : `${summary.batch.attempted} specs attempted, 0 created — check wrangler tail for the underlying error`,
            }).catch(() => {});
          })
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error("[uiu-api] cron dailyRecipeDraft failed:", errorMessage);
            return recordCronRun(env, { jobName: "dailyRecipeDraft", ok: false, errorMessage }).catch(() => {});
          }),
      );
      return;
    }
    // "0 3 * * MON" (Cloudflare weekday numbers are 1 = SUNDAY, so the number form fired on Sundays until 2026-10-19 — use names):
    // (1) the monthly price-refresh kick-off (first Monday for PRICE_REFRESH_SCHEDULE=monthly; no-op otherwise),
    // (2) the weekly recipe_cost precompute, now behind the anomaly gate (nothing is written if a public recipe trips it).
    ctx.waitUntil(
      (async () => {
        try {
          console.log("[uiu-api] cron priceRefresh kick-off:", JSON.stringify(await maybeStartScheduledRun(env)));
        } catch (err) {
          console.error("[uiu-api] cron priceRefresh kick-off failed:", err instanceof Error ? err.message : String(err));
        }
        const summary = await precomputeRecipeCosts(env, false);
        console.log("[uiu-api] cron precompute recipe_cost:", JSON.stringify({ ...summary, gateAnomalies: summary.gateAnomalies.length }));
        if (summary.gateAnomalies.length) {
          await sendTelegram(env, anomalyAlertText("Weekly recipe_cost precompute NOT written", summary.gateAnomalies)).catch(() => {});
        }
      })().catch((err) => {
        console.error("[uiu-api] cron precompute failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  },
};
