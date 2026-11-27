/**
 * Sitemap entries — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/sitemapEntries.test.ts
 */
import type { ApiResponse, RecipeListItem, RecipeListPage } from "@uiu/shared";
import {
  buildSitemapEntries,
  buildSitemapResult,
  createCachedSitemap,
  SITEMAP_MAX_PAGES,
  SITEMAP_PAGE_SIZE,
  type FetchRecipePage,
} from "./sitemapEntries";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, detail ?? "");
  }
}

const STATIC_URLS = [
  "https://useitup.uk/how-it-works",
  "https://useitup.uk/recipes",
  "https://useitup.uk/privacy",
  "https://useitup.uk/terms",
];

function hexId(n: number): string {
  return n.toString(16).padStart(24, "0");
}

function item(id: string, extra: Record<string, unknown> = {}): RecipeListItem {
  return { _id: id, title: `Recipe ${id}`, ...extra } as unknown as RecipeListItem;
}

function okPage(items: RecipeListItem[], total: number, page = 1): ApiResponse<RecipeListPage> {
  return { ok: true, data: { items, page, limit: SITEMAP_PAGE_SIZE, total } };
}

const urls = (entries: { url: string }[]) => entries.map((e) => e.url);
const silent = { onError: () => {} };

async function main() {
  // 1. Success: static pages first, then one entry per public recipe; lastmod only from a valid updatedAt.
  {
    const a = hexId(1);
    const b = hexId(2);
    const calls: number[] = [];
    const fetchPage: FetchRecipePage = async (page) => {
      calls.push(page);
      return okPage([item(a, { updatedAt: "2026-11-20T10:00:00.000Z" }), item(b)], 2);
    };
    const entries = await buildSitemapEntries(fetchPage, silent);
    check("success: static pages kept first", JSON.stringify(urls(entries).slice(0, 4)) === JSON.stringify(STATIC_URLS), urls(entries));
    check("success: recipe URLs use /recipes/<_id>", urls(entries).slice(4).join(",") === `https://useitup.uk/recipes/${a},https://useitup.uk/recipes/${b}`, urls(entries));
    check("success: single API call when total fits one page", calls.length === 1, calls);
    const ea = entries.find((e) => e.url.endsWith(a));
    const eb = entries.find((e) => e.url.endsWith(b));
    check("success: lastmod from updatedAt", ea?.lastModified?.toISOString() === "2026-11-20T10:00:00.000Z", ea);
    check("success: no updatedAt → no lastmod (no invented date)", eb !== undefined && eb.lastModified === undefined, eb);
  }

  // 2. Non-public / malformed / duplicate items are dropped.
  {
    const pub = hexId(10);
    const priv = hexId(11);
    const entries = await buildSitemapEntries(
      async () => okPage([item(pub), item(priv, { isPublic: false }), item("not-an-id"), item(pub)], 4),
      silent,
    );
    const recipeUrls = urls(entries).slice(4);
    check("filter: isPublic:false dropped", !recipeUrls.some((u) => u.endsWith(priv)), recipeUrls);
    check("filter: malformed id dropped, duplicates deduped", recipeUrls.length === 1 && recipeUrls[0].endsWith(pub), recipeUrls);
  }

  // 3. Invalid updatedAt → no lastmod.
  {
    const entries = await buildSitemapEntries(async () => okPage([item(hexId(20), { updatedAt: "not a date" })], 1), silent);
    check("lastmod: invalid updatedAt ignored", entries.length === 5 && entries[4].lastModified === undefined, entries[4]);
  }

  // 4. API ok:false → static pages only.
  {
    let reported = "";
    const entries = await buildSitemapEntries(async () => ({ ok: false, error: { code: "http_502", message: "Upstream error" } }), {
      onError: (m) => (reported = m),
    });
    check("fallback: ok:false → 4 static pages", JSON.stringify(urls(entries)) === JSON.stringify(STATIC_URLS), urls(entries));
    check("fallback: ok:false reported", reported.length > 0);
  }

  // 5. Fetcher throws → static pages only (no throw).
  {
    const entries = await buildSitemapEntries(async () => {
      throw new Error("boom");
    }, silent);
    check("fallback: throw → 4 static pages", JSON.stringify(urls(entries)) === JSON.stringify(STATIC_URLS), urls(entries));
  }

  // 6. Fetcher hangs → timeout → static pages only.
  {
    const started = Date.now();
    const entries = await buildSitemapEntries(() => new Promise(() => {}), { ...silent, timeoutMs: 50 });
    check("fallback: timeout → 4 static pages", JSON.stringify(urls(entries)) === JSON.stringify(STATIC_URLS), urls(entries));
    check("fallback: timeout is prompt", Date.now() - started < 2000, Date.now() - started);
  }

  // 7. Garbage response shape → static pages only.
  {
    const entries = await buildSitemapEntries(async () => ({ ok: true, data: {} }) as unknown as ApiResponse<RecipeListPage>, silent);
    check("fallback: missing items → 4 static pages", entries.length === 4, entries.length);
  }

  // 8. Paging: follows `total`, stops at SITEMAP_MAX_PAGES.
  {
    const calls: number[] = [];
    const fetchPage: FetchRecipePage = async (page, limit) => {
      calls.push(page);
      const items = Array.from({ length: limit }, (_, i) => item(hexId(page * 100000 + i)));
      return okPage(items, 1_000_000, page);
    };
    const warnings: string[] = [];
    const entries = await buildSitemapEntries(fetchPage, { ...silent, onWarn: (m) => warnings.push(m) });
    check("paging: capped at SITEMAP_MAX_PAGES calls", calls.length === SITEMAP_MAX_PAGES, calls);
    check("paging: all pages' recipes included", entries.length === 4 + SITEMAP_MAX_PAGES * SITEMAP_PAGE_SIZE, entries.length);
    check("paging: truncation past the cap warns once", warnings.length === 1 && /truncated/.test(warnings[0]) && warnings[0].includes("1000000"), warnings);
  }
  {
    // Exactly at the cap (total === MAX_PAGES × PAGE_SIZE): nothing truncated → no warning.
    const warnings: string[] = [];
    const exact = SITEMAP_MAX_PAGES * SITEMAP_PAGE_SIZE;
    await buildSitemapEntries(
      async (page, limit) => okPage(Array.from({ length: limit }, (_, i) => item(hexId(page * 100000 + i))), exact, page),
      { ...silent, onWarn: (m) => warnings.push(m) },
    );
    check("paging: total exactly at the cap → no warning", warnings.length === 0, warnings);
  }
  {
    const calls: number[] = [];
    const fetchPage: FetchRecipePage = async (page, limit) => {
      calls.push(page);
      const n = page === 1 ? limit : 10;
      return okPage(Array.from({ length: n }, (_, i) => item(hexId(page * 100000 + i))), limit + 10, page);
    };
    const entries = await buildSitemapEntries(fetchPage, silent);
    check("paging: 2 pages when total = limit + 10", calls.join(",") === "1,2", calls);
    check("paging: 260 recipes", entries.length === 4 + SITEMAP_PAGE_SIZE + 10, entries.length);
  }

  // 9. A later page failing → whole fallback (no half sitemap mixed with errors).
  {
    const fetchPage: FetchRecipePage = async (page, limit) =>
      page === 1 ? okPage(Array.from({ length: limit }, (_, i) => item(hexId(i))), limit * 2) : { ok: false, error: { code: "fetch_failed", message: "x" } };
    const entries = await buildSitemapEntries(fetchPage, silent);
    check("fallback: page 2 failure → 4 static pages", entries.length === 4, entries.length);
  }

  // 10. Timeout really aborts the in-flight request (signal), and the build has a total deadline.
  {
    let aborted = false;
    let sawSignal = false;
    const fetchPage: FetchRecipePage = (_p, _l, signal) => {
      sawSignal = signal !== undefined;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    };
    const entries = await buildSitemapEntries(fetchPage, { ...silent, timeoutMs: 50 });
    check("abort: fetcher receives an AbortSignal", sawSignal);
    check("abort: signal fired on timeout", aborted);
    check("abort: still falls back to 4 static pages", entries.length === 4, entries.length);
  }
  {
    // Fast per-call but slow overall: total deadline stops page 3+ instead of stacking per-call timeouts.
    const calls: number[] = [];
    const fetchPage: FetchRecipePage = async (page, limit) => {
      calls.push(page);
      await new Promise((r) => setTimeout(r, 40));
      return okPage(Array.from({ length: limit }, (_, i) => item(hexId(page * 100000 + i))), 1_000_000, page);
    };
    const errors: string[] = [];
    const entries = await buildSitemapEntries(fetchPage, { timeoutMs: 1000, totalTimeoutMs: 100, onError: (m) => errors.push(m) });
    check("total deadline: stops before MAX_PAGES", calls.length < SITEMAP_MAX_PAGES, calls);
    check("total deadline: falls back to 4 static pages and reports", entries.length === 4 && errors.length === 1, { n: entries.length, errors });
  }
  {
    const ok = await buildSitemapResult(async () => okPage([item(hexId(1))], 1), silent);
    const bad = await buildSitemapResult(async () => ({ ok: false, error: { code: "x", message: "x" } }), silent);
    const empty = await buildSitemapResult(async () => okPage([], 0), silent);
    check("result: ok flag true on success", ok.ok && ok.entries.length === 5);
    check("result: ok flag false on API failure", !bad.ok && bad.entries.length === 4);
    check("result: zero recipes is still ok (not a failure)", empty.ok && empty.entries.length === 4);
  }

  // 11. Cache: reuse within TTL, refresh after, stale-if-error, back-off, failures not cached as good.
  {
    let t = 1_000_000;
    let builds = 0;
    let mode: "ok" | "fail" = "ok";
    let n = 1;
    const build = async () => {
      builds++;
      if (mode === "fail") return { entries: staticFallback(), ok: false };
      return { entries: [...staticFallback(), { url: `https://useitup.uk/recipes/${hexId(n++)}` }], ok: true };
    };
    const staticFallback = () => STATIC_URLS.map((url) => ({ url }));
    const get = createCachedSitemap(build, { ttlMs: 1000, failureBackoffMs: 100, now: () => t });

    const a = await get();
    const b = await get();
    check("cache: second call within TTL reuses (1 build)", builds === 1 && a === b && a.length === 5, builds);

    t += 999;
    await get();
    check("cache: still fresh at TTL-1ms", builds === 1, builds);

    t += 2;
    const c = await get();
    check("cache: rebuilds after TTL", builds === 2 && c.length === 5 && c[4].url.endsWith(hexId(2)), { builds, c });

    mode = "fail";
    t += 1001;
    const d = await get();
    check("cache: API failure after TTL serves stale good result", builds === 3 && d === c, { builds, len: d.length });

    t += 50;
    const e = await get();
    check("cache: failure back-off avoids hammering the API", builds === 3 && e === c, builds);

    t += 100;
    mode = "ok";
    const f = await get();
    check("cache: recovers after back-off", builds === 4 && f.length === 5 && f[4].url.endsWith(hexId(3)), { builds, f });
  }
  {
    // Cold start + API down: static fallback, NOT cached as good → next call after back-off retries.
    let t = 0;
    let builds = 0;
    let mode: "ok" | "fail" = "fail";
    const build = async () => {
      builds++;
      return mode === "fail"
        ? { entries: STATIC_URLS.map((url) => ({ url })), ok: false }
        : { entries: [...STATIC_URLS.map((url) => ({ url })), { url: "https://useitup.uk/recipes/x" }], ok: true };
    };
    const get = createCachedSitemap(build, { ttlMs: 10_000, failureBackoffMs: 100, now: () => t });
    const a = await get();
    check("cache: cold + failure → static fallback", a.length === 4 && builds === 1);
    t += 50;
    await get();
    check("cache: cold + failure → back-off holds", builds === 1, builds);
    t += 100;
    mode = "ok";
    const b = await get();
    check("cache: static fallback never stuck for a full TTL", builds === 2 && b.length === 5, { builds, len: b.length });
  }

  // Hub extra entries: appended after recipes, built from the same (filtered) items, never cost the recipes.
  {
    const a = hexId(40);
    const priv = hexId(41);
    let seenIds: string[] = [];
    const res = await buildSitemapResult(async () => okPage([item(a), item(priv, { isPublic: false })], 2), {
      ...silent,
      extraEntries: (items) => {
        seenIds = items.map((x) => x._id);
        return [{ url: "https://useitup.uk/recipes/ingredient/chicken" }];
      },
    });
    check("extra: appended last", res.ok && urls(res.entries).at(-1) === "https://useitup.uk/recipes/ingredient/chicken", urls(res.entries));
    check("extra: gets only kept (public, valid) items", seenIds.join(",") === a, seenIds);

    const errors: string[] = [];
    const thrown = await buildSitemapResult(async () => okPage([item(a)], 1), {
      onError: (m) => errors.push(m),
      extraEntries: () => {
        throw new Error("hub bug");
      },
    });
    check("extra: throwing hub keeps recipe URLs, ok stays true", thrown.ok && thrown.entries.length === 5 && errors.length === 1, { thrown, errors });

    let called = false;
    const down = await buildSitemapResult(async () => ({ ok: false, error: { code: "x", message: "x" } }), {
      ...silent,
      extraEntries: () => {
        called = true;
        return [{ url: "https://useitup.uk/recipes/ingredient/chicken" }];
      },
    });
    check("extra: not used on API failure (static fallback only)", !down.ok && down.entries.length === 4 && !called, down);
  }

  if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall passed");
}

main().catch((err) => {
  console.log("FAIL unexpected throw", err);
  process.exit(1);
});
