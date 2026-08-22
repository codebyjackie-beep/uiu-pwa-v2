import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_VERSION, type ApiResponse, type HealthCheck } from "@uiu/shared";
import { recipesRouter } from "./routes/recipes";
import { mealPlanRouter } from "./routes/mealPlan";
import { mealPlanSetsRouter } from "./routes/mealPlanSets";
import { adminRecipeDraftsRouter } from "./routes/adminRecipeDrafts";
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
import { precomputeRecipeCosts, type PrecomputeSummary } from "./jobs/precomputeRecipeCosts";
import { recipeCostStats, type RecipeCostStats } from "./jobs/recipeCostStats";
import { dailyRecipeDraft } from "./jobs/dailyRecipeDraft";
import { runDiagnostics, type DiagnosticsRunResult } from "./jobs/pwaDiagnostics";
import { sendTelegram } from "./services/telegram";

/** Bindings declared in wrangler.toml ([vars]) + secrets set out-of-band. */
type Bindings = {
  API_ENV: string;
  MONGODB_DB: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_VISION_MODEL: string;
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
};

const app = new Hono<{ Bindings: Bindings }>();

// Same-origin in production (web + api both on Cloudflare). CORS is permissive here only
// to keep local `wrangler dev` + `next dev` on separate ports talking during development.
app.use("*", cors());

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
app.route("/api/health", healthRouter);
app.route("/api/recipe-import", recipeImportRouter);
app.route("/api/recipe-browse", recipeBrowseStateRouter);

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
    const summary = await precomputeRecipeCosts(c.env, !write);
    const body: ApiResponse<PrecomputeSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recompute-costs error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to compute recipe costs" } };
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
      ctx.waitUntil(
        runDiagnostics(env)
          .then((result) => {
            console.log("[uiu-api] cron pwaDiagnostics:", JSON.stringify({ brokenIssues: result.brokenIssues, alertSent: result.alertSent, digestSent: result.digestSent }));
          })
          .catch((err) => {
            console.error("[uiu-api] cron pwaDiagnostics failed:", err instanceof Error ? err.message : String(err));
          }),
      );
      return;
    }
    if (event.cron === "0 4,7,10,13,16,19,22 * * *") {
      ctx.waitUntil(
        dailyRecipeDraft(env, false)
          .then((summary) => {
            console.log("[uiu-api] cron dailyRecipeDraft:", JSON.stringify({ created: summary.created, skippedDuplicates: summary.skippedDuplicates, batch: summary.batch }));
          })
          .catch((err) => {
            console.error("[uiu-api] cron dailyRecipeDraft failed:", err instanceof Error ? err.message : String(err));
          }),
      );
      return;
    }
    ctx.waitUntil(
      precomputeRecipeCosts(env, false)
        .then((summary) => {
          console.log("[uiu-api] cron precompute recipe_cost:", JSON.stringify(summary));
        })
        .catch((err) => {
          console.error("[uiu-api] cron precompute failed:", err instanceof Error ? err.message : String(err));
        }),
    );
  },
};
