import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_VERSION, type ApiResponse, type HealthCheck } from "@uiu/shared";
import { guestForbidden, requireClerkAuth, requireUser } from "./clerkAuth";
import { recipesRouter } from "./routes/recipes";
import { mealPlanRouter } from "./routes/mealPlan";
import { mealPlanSetsRouter } from "./routes/mealPlanSets";
import { adminRecipeDraftsRouter } from "./routes/adminRecipeDrafts";
import { adminRecipesRouter } from "./routes/adminRecipes";
import { fridgeStockRouter, scanFile, RECEIPT_PROMPT } from "./routes/fridgeStock";
import { diagnoseVideoRecipe, transcribeVideo } from "./services/openrouterVision";
import { parseRecipeFromText } from "./services/recipeImport";
import { mealSuggestionsRouter } from "./routes/mealSuggestions";
import { favouriteRecipesRouter } from "./routes/favouriteRecipes";
import { shopRouter } from "./routes/shop";
import { shoppingListRouter } from "./routes/shoppingList";
import { healthRouter } from "./routes/health";
import { recipeImportRouter } from "./routes/recipeImport";
import { fridgeRecipeGenRouter } from "./routes/fridgeRecipeGen";
import { recipeBrowseStateRouter } from "./routes/recipeBrowseState";
import { precomputeRecipeCosts, type PrecomputeSummary } from "./jobs/precomputeRecipeCosts";
import { anomalyAlertText } from "./jobs/recipeCostGate";
import { recipeCostStats, type RecipeCostStats } from "./jobs/recipeCostStats";
import { dailyRecipeDraft } from "./jobs/dailyRecipeDraft";
import { runDiagnostics, type DiagnosticsRunResult } from "./jobs/pwaDiagnostics";
import { sendTelegram } from "./services/telegram";
import { runIgContentBatch, runAffiliateCron, generateAndSendCollage, type BatchSummary } from "./jobs/igContentAgent";
import { renderCollageImage } from "./services/collageImage";
import { checkIgTokenHealth } from "./jobs/igTokenHealth";
import { planPerItemFill, rollbackPerItemFill, writePerItemFill } from "./services/perItemFill";
import { buildAliasIndex, resolve } from "./services/ingredientResolver";
import { estimateValueWithCanonical } from "./services/fridgeImpact";
import { runInsightsSnapshotCron } from "./jobs/igInsights";
import { igWebhookRouter } from "./routes/igWebhook";
import { adminIgDraftsRouter } from "./routes/adminIgDrafts";
import { affiliateProductsRouter } from "./routes/affiliateProducts";
import { usersRouter } from "./routes/users";
import { billingRouter } from "./routes/billing";
import { igMediaRouter } from "./routes/igMedia";
import { recordCronRun } from "./services/cronHealthMonitor";
import { planRemap, resolvePairs, rollbackRemap, scratchVerify, writeRemap, RemapInputError, USERID_COLLECTIONS, type RemapInput } from "./services/clerkRemap";
import { withDb } from "./db";
import { reviewPublishCandidates } from "./services/publishCandidates";
import { PUSH_SUBSCRIPTIONS, saveSubscription, sendExpiryReminders, sendPush, validSubscription, type PushSubscriptionInput } from "./services/webPush";
import { claimGuestData, cleanupExpiredGuests, mintGuestToken, verifyGuestToken } from "./services/guest";
import { notify, setupChat, NotifyError } from "./services/cloudNotify";
import { priceRefreshRollback, recipeCostRollback, RollbackInputError } from "./services/adminRollbacks";
import { openManualRun, maybeStartScheduledRun, processPriceRefresh, getRun } from "./jobs/priceRefresh";
import { AI_USAGE, getMyPlan, installOpenRouterMeter, premiumGate, type PremiumEnv } from "./services/premium";
import type { PremiumFeature } from "@uiu/shared";

// Milestone 3: per-request OpenRouter cost capture for the Premium usage meter (services/premium.ts).
installOpenRouterMeter();

/** Bindings declared in wrangler.toml ([vars]) + secrets set out-of-band. */
type Bindings = {
  API_ENV: string;
  MONGODB_DB: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_VISION_MODEL: string;
  OPENROUTER_RECEIPT_MODEL?: string;
  OPENROUTER_VIDEO_MODEL?: string;
  // Secrets (not in repo, via `wrangler secret put`):
  //   MONGODB_URI — Atlas connection string.
  //   ADMIN_TOKEN — shared secret checked against X-Admin-Token for /api/admin/* routes.
  //   OPENROUTER_API_KEY — Jackie's own OpenRouter key, shared between the daily recipe
  //     draft agent (OPENROUTER_MODEL) and fridge-stock OCR/photo-scan (OPENROUTER_VISION_MODEL).
  //   RAPIDAPI_KEY / RAPIDAPI_HOST — Spoonacular via RapidAPI, same pair as tools/recipe_ideas/spoonacular_browse.cjs.
  //   PEXELS_API_KEY — recipe photo lookup for approved AI drafts (services/pexels.ts).
  //   YOUTUBE_API_KEY — OPTIONAL, HANDOFF_recipe-social-import.md §0. Powers YouTube Tier 2
  //     (video description text via YouTube Data API v3). Unset -> YouTube links fall
  //     straight to Tier 3 manual paste, does not break the rest of the import flow.
  //   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — HANDOFF_pwa-diagnostics-monitor.md.
  //     Jackie's own Telegram bot/chat, set by Jackie via `wrangler secret put`, never
  //     logged. Powers the diagnostics cron's alert + daily digest messages.
  //   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — OPTIONAL, HANDOFF_pwa-diagnostics-monitor.md.
  //     Read-only Workers scope, used only to look up the latest deployment for the daily
  //     digest. Unset -> diagnostics cron just skips that one info-level line.
  MONGODB_URI: string;
  ADMIN_TOKEN: string;
  OPENROUTER_API_KEY: string;
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
  PEXELS_API_KEY: string;
  YOUTUBE_API_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  PWA_DIAGNOSTICS_RECIPE_COST_MIN_PCT?: string;
  PWA_DIAGNOSTICS_NUTRITION_MIN_PCT?: string;
  PWA_DIAGNOSTICS_DIGEST_HOUR_UK?: string;
  // HANDOFF_ig-marketing-affiliate-agent-design.md — IG Content Agent secrets
  // (IG_ID_UIU / IG_ID_AFFILIATE are [vars], not secrets — see wrangler.toml):
  //   IG_TOKEN_UIU — Page Access Token for @useitup.app.
  //   IG_TOKEN_AFFILIATE — same for @kura.nook. Never mixed with the UIU token —
  //     draft.targetAccount picks which pair is used, never inferred.
  //   TELEGRAM_BOT_TOKEN_IG / TELEGRAM_CHAT_ID_IG — a SEPARATE bot from
  //     TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID above (PWA monitor's "UIU Monitor" bot) —
  //     content review messages must not mix into the diagnostics alert chat.
  //   TELEGRAM_IG_WEBHOOK_SECRET — checked against Telegram's
  //     X-Telegram-Bot-Api-Secret-Token header on the /api/ig-webhook route.
  //   SERPER_API_KEY — serper.dev Google Search API, used for both ASIN lookup
  //     (site:amazon.co.uk) and affiliate product photo search. Amazon itself is
  //     never fetched directly (robots.txt blocks it site-wide, confirmed live).
  //   AMAZON_ASSOCIATE_TAG — Jackie's Amazon.co.uk Associates Tracking ID
  //     (kuranook2026-21), appended to affiliate links via ?tag=.
  IG_TOKEN_UIU: string;
  IG_ID_UIU: string;
  IG_TOKEN_AFFILIATE: string;
  IG_ID_AFFILIATE: string;
  TELEGRAM_BOT_TOKEN_IG: string;
  TELEGRAM_CHAT_ID_IG: string;
  TELEGRAM_IG_WEBHOOK_SECRET: string;
  SERPER_API_KEY: string;
  AMAZON_ASSOCIATE_TAG: string;
  // cc_prompt_atlas_cloud_bg.md — Atlas Cloud (atlascloud.ai) unified inference API key, used
  // for AI-generated IG post background images (services/atlasCloudImage.ts). Raw value:
  // Key\altas-cloud-api.txt (note the file's own typo, not ours).
  ATLAS_CLOUD_API_KEY: string;
  IG_CONTENT_BATCH_SIZE?: string;
  /** "true" pauses every IG cron (token health, affiliate cadence, insights) — Jackie 2026-10-22: old @useitup.app / @kura.nook being deleted. */
  IG_AUTOMATION_PAUSED?: string;
  // 2026-08-25 addendum — public URL of this Worker itself, used to build the branded-image
  // URL (services/igMediaStore.ts) that Instagram/shop.useitup.uk fetch. Not a secret.
  PUBLIC_API_BASE_URL: string;
  /** Milestone 3: "true" = block free users + apply monthly limits. Anything else = record usage only. */
  PREMIUM_ENFORCE?: string;
  /** Milestone 3: comma-separated Clerk user ids always treated as Premium. */
  PREMIUM_COMP_USER_IDS?: string;
  // cc_prompt_milestone1_followup_fixes.md gap 1 — same public value as apps/web's
  // NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, used by src/clerkAuth.ts to find Clerk's JWKS endpoint.
  CLERK_PUBLISHABLE_KEY: string;
  // cc_prompt_price_refresh_monthly_cron.md — guarded Serper price refresh (jobs/priceRefresh.ts).
  //   PRICE_REFRESH_SCHEDULE — "monthly" (default) | "weekly" | "daily"; when a scheduled run is opened.
  //   PRICE_REFRESH_AUTO_WRITE — must be exactly "true" for any run to write; "false" (default) = every run is a dry-run.
  //   PRICE_REFRESH_DOCS_PER_FIRE — docs fetched per "15 * * * *" invocation (default 25).
  PRICE_REFRESH_SCHEDULE?: string;
  PRICE_REFRESH_AUTO_WRITE?: string;
  PRICE_REFRESH_DOCS_PER_FIRE?: string;
  // Cloud-session notifications to Jackie (services/cloudNotify.ts) — secret, dedicated bot.
  CLOUD_NOTIFY_BOT_TOKEN?: string;
  // Use-it-up push reminders (services/webPush.ts).
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
};

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

app.route("/api/recipes", recipesRouter);
app.route("/api/recipes", fridgeRecipeGenRouter);
app.route("/api/meal-plan", mealPlanRouter);
app.route("/api/meal-plan-sets", mealPlanSetsRouter);
app.route("/api/admin/recipe-drafts", adminRecipeDraftsRouter);
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
app.route("/api/affiliate-products", affiliateProductsRouter);
app.route("/api/ig-media", igMediaRouter);

// Manual trigger for the recipe_cost precompute job. Defaults to dry-run
// (never writes) so it's safe to hit over HTTP for verification. Pass
// ?write=true to opt into a real write — this is the explicit, human-watched
// path for the first-ever populate (the Cron Trigger stays disabled until
// that's verified; see wrangler.toml).
app.post("/api/admin/recompute-costs", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
function adminDenied(c: { req: { header(n: string): string | undefined }; env: Bindings }): boolean {
  const token = c.req.header("X-Admin-Token");
  return !token || token !== c.env.ADMIN_TOKEN;
}
function remapError(c: any, err: unknown, where: string) {
  if (err instanceof RemapInputError) return c.json({ ok: false, error: { code: "bad_request", message: err.message } } satisfies ApiResponse<never>, 400);
  console.error(`[uiu-api] ${where} error:`, err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: { code: "db_error", message: `${where} failed` } } satisfies ApiResponse<never>, 502);
}
const UNAUTH_ADMIN: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };

// Milestone 3: read-only AI usage + cost report from ai_usage (services/premium.ts).
//   GET /api/admin/ai-usage?month=YYYY-MM (default current UTC month) → per-feature calls/uses/cost
//   (sum, avg per use) and per-user totals, so pricing/limits can be checked against real numbers.
app.get("/api/admin/ai-usage", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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

app.post("/api/admin/clerk-remap", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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

app.post("/api/admin/clerk-remap/rollback", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  try {
    const out = await withDb(c.env, (db) => rollbackRemap(db, body?.batch ?? "", write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return remapError(c, err, "clerk-remap rollback");
  }
});

app.post("/api/admin/clerk-remap/scratch-verify", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/users/delete-seed", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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

app.post("/api/admin/price-refresh/rollback", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  const write = c.req.query("write") === "true";
  const body = (await c.req.json().catch(() => null)) as { batch?: string; verifyRunId?: string } | null;
  try {
    const out = await withDb(c.env, (db) => priceRefreshRollback(db, body?.batch ?? "", { write, verifyRunId: body?.verifyRunId ?? null }));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return rollbackError(c, err, "price-refresh rollback");
  }
});

app.post("/api/admin/recipe-cost/rollback", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/notify/setup", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  try {
    const out = await withDb(c.env, (db) => setupChat(c.env, db));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    return notifyError(c, err);
  }
});
app.post("/api/admin/notify", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/canonical-per-item-fill", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  const write = c.req.query("write") === "true";
  const out = await withDb(c.env, (db): Promise<unknown> =>
    write ? writePerItemFill(db, `peritem_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${crypto.randomUUID().slice(0, 6)}`) : planPerItemFill(db).then((plan) => ({ dryRun: true, plan })),
  );
  return c.json({ ok: true, data: out });
});
app.post("/api/admin/canonical-per-item-fill/rollback", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  if (!body?.batch) return c.json({ ok: false, error: { code: "bad_request", message: "batch is required" } } satisfies ApiResponse<never>, 400);
  const out = await withDb(c.env, (db) => rollbackPerItemFill(db, body.batch!));
  return c.json({ ok: true, data: out });
});

// Read-only: why does a fridge item get / not get a £ value? (canonical match, per_item_g, price cache, normalizeQty)
app.get("/api/admin/value-probe", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.get("/api/admin/image-proxy", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/guest-cleanup", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/push-reminders", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  const write = c.req.query("write") === "true";
  try {
    const out = await withDb(c.env, (db) => sendExpiryReminders(c.env, db, !write));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] push reminders error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "push_error", message: "push reminders failed" } } satisfies ApiResponse<never>, 502);
  }
});
app.post("/api/admin/push-test", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/users/delete-data", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/vision-test", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/video-test", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/video-transcribe-test", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/video-recipe-test", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.get("/api/admin/scan-errors", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
  try {
    const docs = await withDb(c.env, (db) => db.collection("scan_errors").find({}).sort({ at: -1 }).limit(20).toArray());
    return c.json({ ok: true, data: docs.map((d) => ({ ...d, _id: String(d._id) })) });
  } catch (err) {
    console.error("[uiu-api] scan-errors error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "scan-errors failed" } } satisfies ApiResponse<never>, 502);
  }
});

// TheMealDB publish review (services/publishCandidates.ts) — read-only dry run, writes nothing.
app.get("/api/admin/recipes-publish-review", async (c) => {
  if (adminDenied(c)) return c.json(UNAUTH_ADMIN, 401);
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
app.post("/api/admin/price-refresh", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/price-refresh/step", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    return c.json({ ok: true, data: await processPriceRefresh(c.env) });
  } catch (err) {
    const body: ApiResponse<never> = { ok: false, error: { code: "price_refresh_error", message: err instanceof Error ? err.message : String(err) } };
    return c.json(body, 502);
  }
});
app.get("/api/admin/price-refresh", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
  try {
    const run = await getRun(c.env, c.req.query("runId") ?? null, c.req.query("results") === "true");
    return c.json({ ok: true, data: run });
  } catch (err) {
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: err instanceof Error ? err.message : String(err) } };
    return c.json(body, 502);
  }
});

// Post-populate sanity check — lets Jackie confirm a write landed without
// opening the Atlas UI. Same auth as the route above.
app.get("/api/admin/recipe-cost-stats", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/pwa-diagnostics-run", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/pwa-diagnostics-test-telegram", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-content-batch-run", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-affiliate-cron-run", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-insights-cron-run", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-content/collage", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-content/collage-preview", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
app.post("/api/admin/ig-token-health-run", async (c) => {
  const token = c.req.header("X-Admin-Token");
  if (!token || token !== c.env.ADMIN_TOKEN) {
    const body: ApiResponse<never> = { ok: false, error: { code: "unauthorized", message: "Missing or invalid X-Admin-Token" } };
    return c.json(body, 401);
  }
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
