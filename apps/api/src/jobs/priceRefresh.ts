/**
 * Monthly guarded price refresh (cc_prompt_price_refresh_monthly_cron.md).
 *
 * The guard logic is NOT here — it is the shared services/priceRefreshGuard.ts (one copy, also bundled by scripts/price_refresh.cjs,
 * parity-tested 600/600 against the cloud-reviewed final dry-run). This file is only the Worker plumbing around it:
 *
 *   kick-off   scheduled "0 3 * * MON" (and "15 * * * *" for PRICE_REFRESH_SCHEDULE=daily) -> maybeStartScheduledRun() opens a run
 *   processing scheduled "15 * * * *"  -> processPriceRefresh(): one invocation handles <= DOCS_PER_FIRE docs, no-op without a run
 *   lifecycle  queued -> fetching -> deciding -> writing -> done | aborted      (collection `price_refresh_runs`, resumable)
 *
 * Fetch ALL docs first (Serper), THEN decide, THEN write — nothing is written while fetching. Only guard `update` actions are
 * written (`$set` + old values in `refreshPrev` + `refreshBatch = refresh-auto-YYYYMMDD`, so scripts/price_refresh_rollback.cjs
 * works). hold / hold_rise / hold_drop / hold_low_n / keep_old / fetch_error are never written.
 *
 * Safety: PRICE_REFRESH_AUTO_WRITE must be "true" for ANY write (default "false" => every run is a dry-run). Run-level aborts write
 * nothing: update share > 70% or < 20% of the fetched docs, fetch errors > 10%, credits > 1,500. After a write, public recipe_cost is
 * recomputed through the anomaly gate (recipeCostGate.ts); on an anomaly recipe_cost is NOT written and Telegram lists the anomalies.
 *
 * Not skipped docs cost Serper credits (2 per call, <= 2 calls per doc); skipped = protected, stock family, quarantined, orphan, and
 * the cloud override list (`price_refresh_overrides`).
 */
import type { Collection, Db, Document } from "mongodb";
import { withDb, type DbEnv } from "../db";
import { sendTelegram, type TelegramEnv } from "../services/telegram";
import * as G from "../services/priceRefreshGuard";
import { recomputeRecipeCostsGated, type GatedRecompute } from "./recipeCostGate";

export interface PriceRefreshEnv extends DbEnv, TelegramEnv {
  /** anything other than "production" prefixes every Telegram message with a test tag (scratch-DB runs) */
  API_ENV?: string;
  SERPER_API_KEY: string;
  /** "monthly" (default) | "weekly" | "daily" */
  PRICE_REFRESH_SCHEDULE?: string;
  /** Must be exactly "true" for any run to write. Default (unset / anything else) = dry-run only. */
  PRICE_REFRESH_AUTO_WRITE?: string;
  /** Docs fetched per "15 * * * *" invocation (default 25, clamped 1..40). */
  PRICE_REFRESH_DOCS_PER_FIRE?: string;
}

const SERPER_URL = "https://google.serper.dev/shopping";
const MAX_ATTEMPTS = 2; // first call + retry-on-0-whitelisted once (cloud decision 10-13 point 1)
const CONCURRENCY = 5; // Workers allow 6 simultaneous outgoing connections
const DEFAULT_DOCS_PER_FIRE = 25;
const CREDITS_PER_CALL_FALLBACK = 2; // Serper bills 2 credits per /shopping call; used only when a response omits `credits`
// Run-level abort thresholds (cc_prompt Part 3). Last real run: 283 updates / 573 = 49%.
const MAX_CREDITS = 1500;
const UPDATE_PCT_MAX = 0.7;
const UPDATE_PCT_MIN = 0.2;
const FETCH_ERROR_MAX = 0.1;
const LOCK_MS = 10 * 60 * 1000;
const STALL_MS = 48 * 3600 * 1000; // an active run older than this => one Telegram stall alert (cloud decision 36)

const RUNS = "price_refresh_runs";
const OVERRIDES = "price_refresh_overrides";
const ACTIVE = ["queued", "fetching", "deciding", "writing"] as const;
type RunStatus = (typeof ACTIVE)[number] | "done" | "aborted";

/**
 * Cloud keep_old / skip decisions (rules 15 / 23 / 25 / 26): the Worker never refreshes these until cloud removes the row from
 * `price_refresh_overrides`. Seeded once (see seedOverrides). `tomatoe` (typo canonical) and `sugar` (protected via the Part 0
 * inventory list, not detectable by rule) are also held. `tomato` / `white onion` are NOT skipped any more (cloud decision 34, 10-16):
 * their hand-set values are already correct, so the guard compares against the right current value and hold_rise / hold_low_n protect.
 * NOTE the seed runs once (marker doc): editing this list does not touch an already-seeded collection — remove rows there directly.
 */
const SEED_OVERRIDES: Array<{ name: string; decision: "keep_old" | "skip"; note: string }> = [
  { name: "egg", decision: "keep_old", note: "rule 15: only 1 listing, £0.70 each not plausible" },
  { name: "flank steak", decision: "keep_old", note: "rule 15: £56/kg not plausible" },
  { name: "lump crab meat", decision: "keep_old", note: "rule 15" },
  { name: "corn", decision: "keep_old", note: "rule 23" },
  { name: "vegetable oil", decision: "keep_old", note: "rule 23" },
  { name: "basa fillets", decision: "keep_old", note: "rule 23" },
  { name: "mango", decision: "keep_old", note: "rule 23" },
  { name: "pepper", decision: "keep_old", note: "rule 23: black vs bell pepper ambiguity" },
  { name: "oregano leaves", decision: "skip", note: "rules 25/26: £228/kg dried-herb jar price, recipes use fresh oregano" },
  ...[
    "vinegar", "chili pepper flakes", "dill", "multigrain bread", "ground turmeric", "saffron", "fresh basil, torn", "garlic paste",
    "fresh basil leaves", "lettuce leaves", "snow peas", "muffins", "sage", "tomato slices", "ginger ale", "cola (regular) or ginger ale", "raspberry jam",
  ].map((name) => ({ name, decision: "keep_old" as const, note: "rule 23: small-impact hold" })),
  { name: "sugar", decision: "skip", note: "protected in the 10-16 review via the Part 0 inventory list (not detectable by rule)" },
  { name: "tomatoe", decision: "skip", note: "10-15/16 cloud override (typo canonical, copies tomato); Worker does not replay overrides" },
];

// ------------------------------------------------------------------------------------------------
// types
// ------------------------------------------------------------------------------------------------
interface FetchRow {
  name: string;
  listings: Array<{ store?: string; title?: string; price?: unknown }>;
  calls: Array<{ attempt: number; credits: number; serperResults: number; whitelisted: number }>;
  error?: string;
}
interface ResultRow extends Partial<FetchRow> {
  name: string;
  action?: string;
  reason?: string;
  ratios?: Record<string, number>;
  cur?: G.CurSnapshot;
  newMetric?: number | null;
  newCount?: number | null;
  whitelisted?: number;
  set?: Record<string, unknown>;
  written?: boolean | string;
}
interface RunDoc extends Document {
  runId: string;
  status: RunStatus;
  trigger: "cron" | "manual";
  scheduleKey: string | null;
  schedule: string;
  /** what the caller asked for */
  requestedDryRun: boolean;
  /** effective: true when requested OR PRICE_REFRESH_AUTO_WRITE != "true" */
  dryRun: boolean;
  dryRunReason?: string;
  limited: boolean;
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
  lockedUntil?: Date | null;
  queue: string[];
  cursor: number;
  docsTotal: number;
  skipped: Record<string, number>;
  results: ResultRow[];
  creditsUsed: number;
  serperCalls: number;
  fetchErrors: number;
  batch: string | null;
  abortReasons?: string[];
  checks?: Record<string, unknown>;
  recipeCost?: Record<string, unknown>;
  priceWrites?: number;
  /** set (atomically) when the 48h stall alert has been sent for this run */
  stallAlertSent?: boolean;
  stallAlertAt?: Date;
}

// ------------------------------------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const md = (s: unknown) => String(s ?? "").replace(/([_*`[\]])/g, "\\$1"); // Telegram legacy-Markdown escape
const docsPerFire = (env: PriceRefreshEnv) => {
  const n = Number.parseInt(env.PRICE_REFRESH_DOCS_PER_FIRE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 40) : DEFAULT_DOCS_PER_FIRE;
};
const autoWriteOn = (env: PriceRefreshEnv) => env.PRICE_REFRESH_AUTO_WRITE === "true";
const scheduleOf = (env: PriceRefreshEnv) => (["monthly", "weekly", "daily"].includes(env.PRICE_REFRESH_SCHEDULE ?? "") ? (env.PRICE_REFRESH_SCHEDULE as string) : "monthly");

async function tell(env: PriceRefreshEnv, text: string): Promise<void> {
  try {
    const tag = env.API_ENV && env.API_ENV !== "production" ? `🧪 [${md(env.API_ENV)} / ${md(env.MONGODB_DB)}] ` : "";
    await sendTelegram(env, (tag + text).slice(0, 3900));
  } catch (err) {
    console.error("[uiu-api] priceRefresh telegram failed:", err instanceof Error ? err.message : String(err));
  }
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Mon..Sun by UTC; schedule key = what makes two kick-offs "the same run slot". */
function scheduleKey(schedule: string, now: Date): string | null {
  const dow = now.getUTCDay(); // 0 Sun .. 6 Sat
  const day = now.getUTCDate();
  if (schedule === "monthly") return dow === 1 && day <= 7 ? `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}` : null; // first Monday
  if (schedule === "weekly") return dow === 1 ? `W${ymd(now)}` : null;
  return `D${ymd(now)}`; // daily
}

// ------------------------------------------------------------------------------------------------
// overrides + eligibility
// ------------------------------------------------------------------------------------------------
/** Insert the seed rows once. A marker doc stops re-seeding after cloud removes a row on purpose. */
async function seedOverrides(db: Db): Promise<{ seeded: boolean; count: number }> {
  const col = db.collection<Document>(OVERRIDES);
  const marker = await col.findOne({ _id: "__seed_meta__" as never });
  if (marker) return { seeded: false, count: await col.countDocuments({ canonical_name: { $exists: true } }) };
  const now = new Date();
  await col.bulkWrite(
    SEED_OVERRIDES.map((o) => ({
      updateOne: {
        filter: { canonical_name: o.name },
        update: { $setOnInsert: { canonical_name: o.name, decision: o.decision, note: o.note, ref: "cc_prompt_price_refresh_monthly_cron Part 2", createdAt: now } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  await col.updateOne({ _id: "__seed_meta__" as never }, { $set: { seededAt: now, seedCount: SEED_OVERRIDES.length } }, { upsert: true });
  return { seeded: true, count: SEED_OVERRIDES.length };
}

async function buildQueue(db: Db, restrictTo?: string[]): Promise<{ queue: string[]; skipped: Record<string, number>; ineligibleRequested: string[] }> {
  const canon = await db.collection<Document>("canonical_ingredients").find({}).project({ canonical_name: 1, quarantine: 1 }).toArray();
  const canonByName = new Map(canon.map((c) => [String(c.canonical_name), c]));
  const overrides = new Set((await db.collection<Document>(OVERRIDES).find({ canonical_name: { $exists: true } }).toArray()).map((o) => String(o.canonical_name)));
  const priceDocs = await db.collection<Document>("canonical_price_cache").find({}).toArray();
  const skipped: Record<string, number> = { orphan: 0, quarantined: 0, override: 0, protected: 0, stock_family: 0 };
  const eligible: string[] = [];
  const why = new Map<string, string>();
  for (const d of priceDocs) {
    const name = String(d.canonical_name);
    let reason: string | null = null;
    const c = canonByName.get(name);
    if (!c) reason = "orphan";
    else if (c.quarantine === true) reason = "quarantined";
    else if (overrides.has(name)) reason = "override";
    else if (G.liveProtectReasons(d).length) reason = "protected";
    else if (G.STOCK_NAME_RE.test(name)) reason = "stock_family"; // unprotected stock docs are handled by the stock-group path, not here
    why.set(name, reason ?? "eligible");
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else eligible.push(name);
  }
  eligible.sort();
  if (!restrictTo) return { queue: eligible, skipped, ineligibleRequested: [] };
  const el = new Set(eligible);
  return {
    queue: restrictTo.filter((n) => el.has(n)),
    skipped,
    ineligibleRequested: restrictTo.filter((n) => !el.has(n)).map((n) => `${n}:${why.get(n) ?? "no_price_doc"}`),
  };
}

// ------------------------------------------------------------------------------------------------
// opening a run
// ------------------------------------------------------------------------------------------------
export interface OpenOptions {
  trigger: "cron" | "manual";
  requestedDryRun: boolean;
  /** manual testing only: restrict the run to these canonical names / the first N eligible */
  names?: string[];
  limit?: number;
  scheduleKey?: string | null;
}
export type OpenResult =
  | { opened: true; runId: string; docsTotal: number; dryRun: boolean; dryRunReason?: string; skipped: Record<string, number>; ineligibleRequested: string[] }
  | { opened: false; reason: "active_run" | "no_eligible_docs" | "write_disabled"; activeRunId?: string; activeStatus?: string };

async function openRun(env: PriceRefreshEnv, db: Db, o: OpenOptions): Promise<OpenResult> {
  const runs = db.collection<RunDoc>(RUNS);
  await runs.createIndex({ runId: 1 }, { unique: true });
  await runs.createIndex({ status: 1, startedAt: 1 });
  const active = await runs.findOne({ status: { $in: [...ACTIVE] } }, { projection: { runId: 1, status: 1 } });
  if (active) return { opened: false, reason: "active_run", activeRunId: active.runId, activeStatus: active.status };

  const writeOn = autoWriteOn(env);
  if (!o.requestedDryRun && !writeOn && o.trigger === "manual") return { opened: false, reason: "write_disabled" };
  const dryRun = o.requestedDryRun || !writeOn;
  const dryRunReason = o.requestedDryRun ? undefined : !writeOn ? "PRICE_REFRESH_AUTO_WRITE is not true" : undefined;

  await seedOverrides(db);
  const limited = Boolean((o.names && o.names.length) || o.limit);
  let { queue, skipped, ineligibleRequested } = await buildQueue(db, o.names && o.names.length ? o.names : undefined);
  if (o.limit && o.limit > 0) queue = queue.slice(0, o.limit);
  if (!queue.length) return { opened: false, reason: "no_eligible_docs" };

  const now = new Date();
  const runId = `pr-${ymd(now)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const doc: RunDoc = {
    runId,
    status: "queued",
    trigger: o.trigger,
    scheduleKey: o.scheduleKey ?? null,
    schedule: scheduleOf(env),
    requestedDryRun: o.requestedDryRun,
    dryRun,
    ...(dryRunReason ? { dryRunReason } : {}),
    limited,
    startedAt: now,
    updatedAt: now,
    lockedUntil: null,
    queue,
    cursor: 0,
    docsTotal: queue.length,
    skipped,
    results: [],
    creditsUsed: 0,
    serperCalls: 0,
    fetchErrors: 0,
    batch: null,
  };
  await runs.insertOne(doc as never);
  return { opened: true, runId, docsTotal: queue.length, dryRun, ...(dryRunReason ? { dryRunReason } : {}), skipped, ineligibleRequested };
}

/** Manual entry (POST /api/admin/price-refresh). Opens a run then processes the first batch right away. */
export async function openManualRun(env: PriceRefreshEnv, o: { dryRun: boolean; names?: string[]; limit?: number }): Promise<{ open: OpenResult; processed?: ProcessResult }> {
  const open = await withDb(env, (db) => openRun(env, db, { trigger: "manual", requestedDryRun: o.dryRun, names: o.names, limit: o.limit }));
  if (!open.opened) return { open };
  const processed = await processPriceRefresh(env);
  return { open, processed };
}

/** Scheduled kick-off. Called from the "0 3 * * MON" cron (and from "15 * * * *" for the daily schedule). */
export async function maybeStartScheduledRun(env: PriceRefreshEnv, now = new Date()): Promise<{ started: boolean; reason: string }> {
  const schedule = scheduleOf(env);
  const key = scheduleKey(schedule, now);
  if (!key) {
    // Wrong-day guard (2026-10-19 incident): Cloudflare cron weekday 1 = SUNDAY, so "0 3 * * 1" fired on Sundays, scheduleKey() said
    // "not a Monday" and the kick-off returned silently for weeks. A null key is only legitimate for the monthly schedule on a
    // Monday that is not the first one; any other null (weekly any day, monthly on a non-Monday) means the cron is on the wrong day.
    if (schedule !== "monthly" || now.getUTCDay() !== 1) {
      await tell(env, `⚠️ *Price refresh kick-off fired on the wrong day* (schedule ${md(schedule)}, UTC ${md(DOW_NAMES[now.getUTCDay()])} ${md(now.toISOString())}).\nNo run opened. Cloudflare cron weekday numbers are 1 = Sunday — check the \`0 3 * * MON\` trigger in wrangler.toml.`);
    }
    return { started: false, reason: `not_a_${schedule}_slot` };
  }
  return withDb(env, async (db) => {
    const runs = db.collection<RunDoc>(RUNS);
    // one run per slot: a second call in the same slot (e.g. Monday 03:00 cron + the daily 03:15 fire) is a silent no-op
    if (await runs.findOne({ scheduleKey: key }, { projection: { runId: 1 } })) return { started: false, reason: "slot_already_opened" };
    const active = await runs.findOne({ status: { $in: [...ACTIVE] } }, { projection: { runId: 1, status: 1, cursor: 1, docsTotal: 1, startedAt: 1 } });
    if (active) {
      await tell(env, `⚠️ *Price refresh NOT started* (${md(schedule)} slot ${md(key)})\nPrevious run \`${active.runId}\` is still \`${active.status}\` (${active.cursor}/${active.docsTotal} fetched, started ${new Date(active.startedAt).toISOString()}).\nNo new run opened — check \`wrangler tail\` / the run doc.`);
      return { started: false, reason: "previous_run_not_done" };
    }
    const r = await openRun(env, db, { trigger: "cron", requestedDryRun: false, scheduleKey: key });
    if (!r.opened) {
      await tell(env, `⚠️ *Price refresh NOT started* (slot ${md(key)}): ${md(r.reason)}`);
      return { started: false, reason: r.reason };
    }
    console.log("[uiu-api] priceRefresh opened", JSON.stringify({ runId: r.runId, docsTotal: r.docsTotal, dryRun: r.dryRun, skipped: r.skipped }));
    return { started: true, reason: r.runId };
  });
}

// ------------------------------------------------------------------------------------------------
// Serper fetch (same request body / whitelist / retry-once as scripts/price_refresh.cjs)
// ------------------------------------------------------------------------------------------------
async function serperShopping(apiKey: string, q: string): Promise<{ shopping: Array<{ source?: string; title?: string; price?: unknown }>; credits: number | null }> {
  const resp = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q, gl: "gb", location: "United Kingdom" }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Serper HTTP ${resp.status}: ${text.slice(0, 160)}`);
  let body: { shopping?: unknown; credits?: unknown } | null = null;
  try { body = JSON.parse(text); } catch { /* keep null */ }
  const shopping = Array.isArray(body?.shopping) ? (body!.shopping as Array<{ source?: string; title?: string; price?: unknown }>) : [];
  return { shopping, credits: typeof body?.credits === "number" ? body.credits : null };
}
async function fetchDoc(apiKey: string, name: string): Promise<FetchRow> {
  const row: FetchRow = { name, listings: [], calls: [] };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const { shopping, credits } = await serperShopping(apiKey, `${name} price`);
      const uk = shopping.filter((s) => G.isUkSupermarket(s.source));
      row.calls.push({ attempt, credits: credits ?? CREDITS_PER_CALL_FALLBACK, serperResults: shopping.length, whitelisted: uk.length });
      row.listings = uk.map((s) => ({ store: s.source, title: s.title, price: s.price }));
      if (row.listings.length >= 1) break;
    }
  } catch (err) {
    row.error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  }
  return row;
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k] as T); }
  }));
  return out;
}

// ------------------------------------------------------------------------------------------------
// processing one invocation
// ------------------------------------------------------------------------------------------------
export interface ProcessResult {
  ran: boolean;
  runId?: string;
  status?: string;
  fetchedThisFire?: number;
  cursor?: number;
  docsTotal?: number;
  creditsUsed?: number;
}

/**
 * The job is deliberately not registered in cronHealthMonitor (idle fires would read as "0 items" all month), so a stuck run has to
 * announce itself: every "15 * * * *" fire checks the active run and, once it is older than STALL_MS, Telegrams ONCE. The flag is set
 * with an atomic findOneAndUpdate so two overlapping invocations cannot both alert.
 */
async function alertIfStalled(env: PriceRefreshEnv, runs: Collection<RunDoc>, now: Date): Promise<void> {
  try {
    const stalled = await runs.findOneAndUpdate(
      { status: { $in: [...ACTIVE] }, startedAt: { $lt: new Date(now.getTime() - STALL_MS) }, stallAlertSent: { $ne: true } },
      { $set: { stallAlertSent: true, stallAlertAt: now } },
      { returnDocument: "after" },
    );
    if (!stalled) return;
    const hours = Math.round((now.getTime() - new Date(stalled.startedAt).getTime()) / 3_600_000);
    await tell(
      env,
      `⏰ *Price refresh STALLED*\nRun \`${stalled.runId}\` (${stalled.trigger}${stalled.dryRun ? ", dry-run" : ""}) is still \`${md(stalled.status)}\` after ${hours}h — ${stalled.cursor}/${stalled.docsTotal} fetched, credits ${stalled.creditsUsed}, errors ${stalled.fetchErrors}.\nNo new run can open until it finishes. Check \`wrangler tail\` and the \`price_refresh_runs\` doc \`${stalled.runId}\`. (One alert per run.)`,
    );
  } catch (err) {
    console.error("[uiu-api] priceRefresh stall check failed:", err instanceof Error ? err.message : String(err));
  }
}

export async function processPriceRefresh(env: PriceRefreshEnv): Promise<ProcessResult> {
  return withDb(env, async (db) => {
    const runs = db.collection<RunDoc>(RUNS);
    const now = new Date();
    await alertIfStalled(env, runs, now);
    // claim: an active run that nobody holds a live lock on
    const run = await runs.findOneAndUpdate(
      { status: { $in: [...ACTIVE] }, $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS), updatedAt: now } },
      { sort: { startedAt: 1 }, returnDocument: "after" },
    );
    if (!run) return { ran: false };
    const out: ProcessResult = { ran: true, runId: run.runId };
    try {
      if (run.status === "queued") {
        await runs.updateOne({ runId: run.runId }, { $set: { status: "fetching" } });
        run.status = "fetching";
      }
      if (run.status === "fetching") {
        const slice = run.queue.slice(run.cursor, run.cursor + docsPerFire(env));
        const rows = await pool(slice, CONCURRENCY, (name) => fetchDoc(env.SERPER_API_KEY, name));
        const credits = rows.reduce((s, r) => s + r.calls.reduce((a, c) => a + c.credits, 0), 0);
        const calls = rows.reduce((s, r) => s + r.calls.length, 0);
        const errors = rows.filter((r) => r.error).length;
        run.cursor += slice.length;
        run.creditsUsed += credits;
        run.serperCalls += calls;
        run.fetchErrors += errors;
        out.fetchedThisFire = slice.length;
        await db.collection<Document>(RUNS).updateOne(
          { runId: run.runId },
          { $push: { results: { $each: rows } } as never, $set: { cursor: run.cursor, updatedAt: new Date() }, $inc: { creditsUsed: credits, serperCalls: calls, fetchErrors: errors } },
        );
        // abort early: no point spending more credits on a run that is already outside the limits
        const early: string[] = [];
        if (run.creditsUsed > MAX_CREDITS) early.push(`credits ${run.creditsUsed} > ${MAX_CREDITS}`);
        if (!run.limited && run.fetchErrors / run.docsTotal > FETCH_ERROR_MAX) early.push(`fetch errors ${run.fetchErrors}/${run.docsTotal} > ${FETCH_ERROR_MAX * 100}%`);
        if (early.length) {
          await finishAborted(env, db, run, early);
          return { ...out, status: "aborted", cursor: run.cursor, docsTotal: run.docsTotal, creditsUsed: run.creditsUsed };
        }
        if (run.cursor >= run.queue.length) {
          await runs.updateOne({ runId: run.runId }, { $set: { status: "deciding" } });
          run.status = "deciding";
        }
      }
      if (run.status === "deciding") {
        const fresh = (await runs.findOne({ runId: run.runId })) as RunDoc;
        await decide(env, db, fresh);
        const after = (await runs.findOne({ runId: run.runId }, { projection: { status: 1 } })) as RunDoc;
        run.status = after.status;
      }
      if (run.status === "writing") {
        const fresh = (await runs.findOne({ runId: run.runId })) as RunDoc;
        await writeAndFinish(env, db, fresh);
      }
      const last = (await runs.findOne({ runId: run.runId }, { projection: { status: 1, cursor: 1, docsTotal: 1, creditsUsed: 1 } })) as RunDoc;
      return { ...out, status: last.status, cursor: last.cursor, docsTotal: last.docsTotal, creditsUsed: last.creditsUsed };
    } finally {
      await runs.updateOne({ runId: run.runId }, { $set: { lockedUntil: null } }).catch(() => {});
    }
  });
}

// ------------------------------------------------------------------------------------------------
// decide (all fetched -> guard actions, run-level checks)
// ------------------------------------------------------------------------------------------------
const countActions = (rows: ResultRow[]) => G.countBy(rows, (r) => r.action ?? "unknown");

/**
 * Fetched rows -> guard decisions, against the price/canonical docs as they are NOW. Pure (no I/O) so scripts/price_refresh_redecide.cjs
 * can re-decide a finished run from its stored listings (0 credits) with exactly the code the Worker runs.
 * `refreshed` (doc.refreshBatch set = an earlier refresh already wrote it) switches on the hold_drop guard (cloud decision 40).
 */
export function buildDecisionRows(fetched: ResultRow[], priceMap: Map<string, Document>, canonMap: Map<string, Document>): ResultRow[] {
  return fetched.map((fr): ResultRow => {
    const name = fr.name;
    const base: ResultRow = { name, calls: fr.calls, whitelisted: fr.listings?.length ?? 0, listings: fr.listings };
    const doc = priceMap.get(name);
    const canon = canonMap.get(name);
    if (!doc || !canon || canon.quarantine === true) return { ...base, action: "skipped_not_eligible", reason: !doc ? "price doc gone" : !canon ? "orphan" : "quarantined" };
    const prot = G.liveProtectReasons(doc);
    if (prot.length) return { ...base, action: "protected_skip", reason: prot.join(" | ") };
    const cur = G.curSnapshot(doc);
    if (fr.error) return { ...base, action: "fetch_error", reason: fr.error, cur };
    const listings = fr.listings ?? [];
    const ctx = { matcher: G.makeTitleMatcher(canon, doc), referencePack: (canon.reference_pack as G.Pack | undefined) ?? null };
    const { g, decision } = G.evaluateListings(listings, cur, ctx, Boolean(doc.refreshBatch));
    const row: ResultRow = {
      ...base,
      action: decision.action,
      reason: decision.reason,
      ...(decision.ratios ? { ratios: decision.ratios } : {}),
      cur,
      newMetric: g.per_unit_metric?.value ?? null,
      newCount: g.per_unit_count?.value ?? null,
    };
    if (decision.action === "update") row.set = G.buildUpdateSet(name, g, decision, listings.length, fr.calls?.length ?? null);
    return row;
  });
}

async function decide(env: PriceRefreshEnv, db: Db, run: RunDoc): Promise<void> {
  const runs = db.collection<RunDoc>(RUNS);
  const names = run.results.map((r) => r.name);
  const priceMap = new Map((await db.collection<Document>("canonical_price_cache").find({ canonical_name: { $in: names } }).toArray()).map((d) => [String(d.canonical_name), d]));
  const canonMap = new Map((await db.collection<Document>("canonical_ingredients").find({ canonical_name: { $in: names } }).toArray()).map((d) => [String(d.canonical_name), d]));

  const rows = buildDecisionRows(run.results, priceMap, canonMap);

  const actions = countActions(rows);
  const updates = actions.update ?? 0;
  const fetched = run.docsTotal;
  const updatePct = fetched ? updates / fetched : 0;
  const fetchErrPct = fetched ? run.fetchErrors / fetched : 0;
  const abortReasons: string[] = [];
  if (!run.limited) {
    if (updatePct > UPDATE_PCT_MAX) abortReasons.push(`update ${updates}/${fetched} = ${(updatePct * 100).toFixed(1)}% > ${UPDATE_PCT_MAX * 100}%`);
    if (updatePct < UPDATE_PCT_MIN) abortReasons.push(`update ${updates}/${fetched} = ${(updatePct * 100).toFixed(1)}% < ${UPDATE_PCT_MIN * 100}%`);
    if (fetchErrPct > FETCH_ERROR_MAX) abortReasons.push(`fetch errors ${run.fetchErrors}/${fetched} = ${(fetchErrPct * 100).toFixed(1)}% > ${FETCH_ERROR_MAX * 100}%`);
  }
  if (run.creditsUsed > MAX_CREDITS) abortReasons.push(`credits ${run.creditsUsed} > ${MAX_CREDITS}`);
  const checks = { actions, updates, fetched, updatePct: Math.round(updatePct * 1000) / 1000, fetchErrPct: Math.round(fetchErrPct * 1000) / 1000, creditsUsed: run.creditsUsed, thresholds: { UPDATE_PCT_MAX, UPDATE_PCT_MIN, FETCH_ERROR_MAX, MAX_CREDITS }, wouldAbort: abortReasons };

  // persist the decisions first (resumable), whatever happens next
  await runs.updateOne({ runId: run.runId }, { $set: { results: rows as never[], checks, updatedAt: new Date() } });
  run.results = rows;
  run.checks = checks;

  if (abortReasons.length && !run.dryRun) {
    await finishAborted(env, db, run, abortReasons);
    return;
  }
  if (run.dryRun) {
    // project what recipe_cost would be with the proposed prices — nothing is written
    const overlay = new Map<string, Document>();
    for (const r of rows) {
      if (r.action !== "update" || !r.set) continue;
      const d = priceMap.get(r.name);
      if (d) overlay.set(r.name, applySet(d, r.set));
    }
    const rc = await recomputeRecipeCostsGated(db, { write: false, priceOverlay: overlay });
    const recipeCost = { projection: true, ...gateSummary(rc) };
    await runs.updateOne({ runId: run.runId }, { $set: { status: "done", finishedAt: new Date(), recipeCost, updatedAt: new Date() } });
    run.recipeCost = recipeCost;
    await tell(env, summaryText(run, rows, "DRY-RUN (nothing written)"));
    return;
  }
  // real run: pick the batch id now so a resumed write step reuses it
  const base = `refresh-auto-${ymd(new Date(run.startedAt))}`;
  const clash = await runs.countDocuments({ batch: { $regex: `^${base}(-\\d+)?$` } });
  const batch = clash ? `${base}-${clash + 1}` : base;
  await runs.updateOne({ runId: run.runId }, { $set: { status: "writing", batch, updatedAt: new Date() } });
}

/** apply a `$set` document (dotted keys allowed) to a copy of a Mongo doc — dry-run projection only */
export function applySet(doc: Document, set: Record<string, unknown>): Document {
  const out: Document = { ...doc };
  for (const [k, v] of Object.entries(set)) {
    if (k.includes(".")) {
      const [head, ...rest] = k.split(".");
      const h = head as string;
      const obj: Record<string, unknown> = { ...((out[h] as Record<string, unknown> | undefined) ?? {}) };
      obj[rest.join(".")] = v;
      out[h] = obj;
    } else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// write (only `update`), recipe_cost through the gate, summary
// ------------------------------------------------------------------------------------------------
async function writeAndFinish(env: PriceRefreshEnv, db: Db, run: RunDoc): Promise<void> {
  const runs = db.collection<RunDoc>(RUNS);
  const col = db.collection<Document>("canonical_price_cache");
  const batch = run.batch as string;
  const targets = run.results.filter((r) => r.action === "update" && r.set);
  const live = new Map((await col.find({ canonical_name: { $in: targets.map((t) => t.name) } }).toArray()).map((d) => [String(d.canonical_name), d]));
  const now = new Date();
  const ops: Array<{ updateOne: { filter: Document; update: Document } }> = [];
  for (const t of targets) {
    const d = live.get(t.name);
    if (!d) { t.written = "skipped_missing"; continue; }
    if (d.refreshBatch === batch) { t.written = "already"; continue; } // resumed run
    if (G.liveProtectReasons(d).length) { t.written = "skipped_protected_now"; continue; }
    if (t.cur && !G.snapshotsEqual(G.curSnapshot(d), t.cur)) { t.written = "skipped_changed_since_decide"; continue; }
    const set: Document = { ...(t.set as Document), refreshBatch: batch, refreshAt: now, refreshPrev: G.refreshPrevOf(d), "metadata.fetched_at": now };
    ops.push({ updateOne: { filter: { canonical_name: t.name, refreshBatch: { $ne: batch } }, update: { $set: set } } });
    t.written = true;
  }
  let modified = 0;
  for (let i = 0; i < ops.length; i += 100) {
    const res = await col.bulkWrite(ops.slice(i, i + 100), { ordered: false });
    modified += res.modifiedCount;
  }
  await runs.updateOne({ runId: run.runId }, { $set: { results: run.results as never[], priceWrites: modified, updatedAt: new Date() } });

  // recipe_cost: recompute from the DB as it is NOW, through the anomaly gate
  const rc = await recomputeRecipeCostsGated(db, { write: true });
  const recipeCost = { projection: false, ...gateSummary(rc) };
  await runs.updateOne({ runId: run.runId }, { $set: { status: "done", finishedAt: new Date(), recipeCost, updatedAt: new Date() } });
  run.priceWrites = modified;
  run.recipeCost = recipeCost;
  await tell(env, summaryText(run, run.results, `WRITTEN ${modified} price docs`));
}

async function finishAborted(env: PriceRefreshEnv, db: Db, run: RunDoc, reasons: string[]): Promise<void> {
  await db.collection<RunDoc>(RUNS).updateOne({ runId: run.runId }, { $set: { status: "aborted", abortReasons: reasons, finishedAt: new Date(), updatedAt: new Date() } });
  run.status = "aborted";
  await tell(
    env,
    `🛑 *Price refresh ABORTED — nothing written*\nRun \`${run.runId}\` (${run.trigger}${run.dryRun ? ", dry-run" : ""})\n${reasons.map((r) => `• ${md(r)}`).join("\n")}\nFetched ${run.cursor}/${run.docsTotal}, credits ${run.creditsUsed}, errors ${run.fetchErrors}.\nInspect: \`price_refresh_runs\` doc \`${run.runId}\``,
  );
}

function gateSummary(rc: GatedRecompute) {
  return {
    wrote: rc.wrote,
    publicRecipes: rc.publicRecipes,
    publicChanged: rc.publicChanged,
    anomalies: rc.anomalies,
    before: rc.before,
    after: rc.after,
    lineWeightedAdjustedPct: Math.round(rc.lineWeightedAdjustedPct * 1e4) / 1e4,
  };
}

function summaryText(run: RunDoc, rows: ResultRow[], headline: string): string {
  const actions = countActions(rows);
  const rc = run.recipeCost as (ReturnType<typeof gateSummary> & { projection: boolean }) | undefined;
  const dist = (s?: GatedRecompute["before"]) => (s ? `<£1.5 ${s.perServing.under1_5} · £1.5–3 ${s.perServing["1_5to3"]} · £3+ ${s.perServing["3plus"]} · n/a ${s.perServing.excluded}` : "n/a");
  const plan = (s?: GatedRecompute["before"]) => (s && s.weeklyPlan6.length ? s.weeklyPlan6.map((p) => `£${p.total.toFixed(2)}`).join(" / ") : "n/a");
  const lines = [
    `💷 *Price refresh ${md(headline)}*`,
    `Run \`${run.runId}\` (${run.trigger}, ${run.schedule})${run.dryRunReason ? ` — ${md(run.dryRunReason)}` : ""}`,
    `Docs fetched ${run.docsTotal} (skipped: ${Object.entries(run.skipped).map(([k, v]) => `${md(k)} ${v}`).join(", ")})`,
    `Actions: ${Object.entries(actions).map(([k, v]) => `${md(k)} ${v}`).join(" · ")}`,
    `hold\\_drop (already-refreshed docs, drop >23%, not written): ${actions.hold_drop ?? 0}`,
    `Credits ${run.creditsUsed} (${run.serperCalls} calls), fetch errors ${run.fetchErrors}`,
  ];
  const wouldAbort = (run.checks?.wouldAbort as string[] | undefined) ?? [];
  if (wouldAbort.length) lines.push(`⚠️ would abort a real run: ${wouldAbort.map(md).join("; ")}`);
  if (rc) {
    lines.push(`Per-serving (public recipes) ${rc.projection ? "now → projected" : "before → after"}:`);
    lines.push(`  ${dist(rc.before)}`);
    lines.push(`  ${dist(rc.after)}`);
    lines.push(`Weekly Plan 6: ${plan(rc.before)} → ${plan(rc.after)}`);
    if (rc.anomalies.length) {
      lines.push(`🚨 recipe\\_cost ${rc.projection ? "WOULD NOT be" : "NOT"} written — ${rc.anomalies.length} anomaly(ies), price docs stay written (rollback below):`);
      for (const a of rc.anomalies.slice(0, 10)) lines.push(`  • ${md(a.title)}: ${md(a.rule)} (${a.before} → ${a.after})`);
      if (rc.anomalies.length > 10) lines.push(`  … +${rc.anomalies.length - 10} more (see run doc)`);
    } else lines.push(rc.wrote ? "recipe\\_cost written (no anomalies)" : "recipe\\_cost: no anomalies");
  }
  if (run.batch) {
    lines.push(`Batch \`${run.batch}\``);
    lines.push(`Rollback: \`node scripts/price_refresh_rollback.cjs ${run.batch} --verify-run ${run.runId} --write\` then \`POST /api/admin/recompute-costs?write=true\``);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------
// read helper for the admin GET route
// ------------------------------------------------------------------------------------------------
export async function getRun(env: PriceRefreshEnv, runId: string | null, withResults: boolean): Promise<Document | null> {
  return withDb(env, async (db) => {
    const col = db.collection<Document>(RUNS);
    const proj = withResults ? {} : { projection: { results: 0, queue: 0 } };
    return runId ? col.findOne({ runId }, proj) : (await col.find({}, proj).sort({ startedAt: -1 }).limit(1).toArray())[0] ?? null;
  });
}
