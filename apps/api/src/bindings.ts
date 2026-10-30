/** Bindings declared in wrangler.toml ([vars]) + secrets set out-of-band. */
export type Bindings = {
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
  //   CLERK_WEBHOOK_SECRET — OPTIONAL, whsec_… signing secret of the Clerk webhook endpoint (/api/webhooks/clerk, user.deleted).
  //     Unset -> the endpoint answers 503 and nothing is deleted.
  CLERK_WEBHOOK_SECRET?: string;
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
