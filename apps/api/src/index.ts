import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_VERSION, type ApiResponse, type HealthCheck } from "@uiu/shared";
import { recipesRouter } from "./routes/recipes";
import { precomputeRecipeCosts, type PrecomputeSummary } from "./jobs/precomputeRecipeCosts";

/** Bindings declared in wrangler.toml ([vars]) + secrets set out-of-band. */
type Bindings = {
  API_ENV: string;
  MONGODB_DB: string;
  // Secret (not in repo): MONGODB_URI — Atlas connection string, via `wrangler secret put`.
  MONGODB_URI: string;
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

// Feature routes (health) get mounted here as they land.

// Manual trigger for the recipe_cost precompute job — always dry-run (never
// writes) so it's safe to hit over HTTP for verification. The real,
// DB-writing run only happens via the `scheduled()` Cron Trigger below.
app.post("/api/admin/recompute-costs", async (c) => {
  try {
    const summary = await precomputeRecipeCosts(c.env, true);
    const body: ApiResponse<PrecomputeSummary> = { ok: true, data: summary };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] recompute-costs dry-run error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to compute recipe costs" } };
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
   * Cloudflare Cron Trigger handler — replaces the old repo's long-running
   * Mongoose precompute_recipe_costs.js. Writes to `recipe_cost` for real
   * (dryRun:false). Scheduled via wrangler.toml [triggers].
   */
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
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
