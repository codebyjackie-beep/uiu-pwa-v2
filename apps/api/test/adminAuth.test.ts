/**
 * Admin gate regression test — standalone assertion script (no vitest/jest in this repo; same
 * style as src/routes/shoppingList.fridgeMatch.test.ts; kept outside src/ so the Worker tsconfig never sees Node APIs). Run with:
 *   1. cd apps/api && npx wrangler dev --port 8787 --var ADMIN_TOKEN:test-admin-token
 *   2. npx tsx apps/api/test/adminAuth.test.ts            (API_TEST_URL / ADMIN_TEST_TOKEN to override)
 * It talks to the real Worker over HTTP because the bundle imports Worker-only assets (.ttf, .wasm)
 * that plain Node can't load. Never point it at production with the real token.
 *
 * Reads every /api/admin/* route straight from the source (index.ts inline routes + the admin
 * sub-routers + routes/admin.ts once it exists) and fires each one at the real Worker app with
 * no token and with a wrong token. Every one must return 401 before any handler code runs.
 * A newly added admin route is picked up automatically — that is the point of the test.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAdminToken } from "../src/adminAuth";

const here = join(dirname(fileURLToPath(import.meta.url)), "../src");
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}

// --- isAdminToken unit cases ---
check("exact match", isAdminToken("s3cret", "s3cret"));
check("missing token", !isAdminToken(undefined, "s3cret"));
check("empty token", !isAdminToken("", "s3cret"));
check("unset secret", !isAdminToken("s3cret", undefined));
check("unset secret + empty", !isAdminToken("", ""));
check("wrong token", !isAdminToken("s3creT", "s3cret"));
check("prefix", !isAdminToken("s3cre", "s3cret"));
check("longer", !isAdminToken("s3cret!", "s3cret"));

// --- collect every admin route from source ---
type Route = { method: string; path: string };
const routes: Route[] = [];
const verb = "(get|post|put|patch|delete)";
const src = (f: string) => readFileSync(join(here, f), "utf8");

for (const f of ["index.ts", "routes/admin.ts"]) {
  if (!existsSync(join(here, f))) continue;
  const prefix = f === "index.ts" ? "" : "/api/admin";
  const re = new RegExp(String.raw`^(?:app|adminRouter)\.${verb}\("([^"]+)"`, "gm");
  for (const m of src(f).matchAll(re)) {
    const path = prefix + m[2];
    if (path.startsWith("/api/admin")) routes.push({ method: m[1].toUpperCase(), path });
  }
}
const mounts: Array<[string, string]> = [
  ["routes/adminRecipeDrafts.ts", "/api/admin/recipe-drafts"],
  ["routes/adminRecipes.ts", "/api/admin/recipes"],
  ["routes/adminIgDrafts.ts", "/api/admin/ig-drafts"],
];
for (const [f, base] of mounts) {
  const re = new RegExp(String.raw`^\w+Router\.${verb}\("([^"]+)"`, "gm");
  for (const m of src(f).matchAll(re)) routes.push({ method: m[1].toUpperCase(), path: base + (m[2] === "/" ? "" : m[2]) });
}

const EXPECTED_ROUTES = 62; // 42 inline (routes/admin.ts, incl. 3 price-refresh/overrides + 2 canonical-price/per-unit-count + user-deletion) + 10 recipe-drafts (incl. 3 triage) + 4 recipes + 6 ig-drafts
check("route count", routes.length === EXPECTED_ROUTES, `found ${routes.length}, expected ${EXPECTED_ROUTES}`);

// --- fire each route at the real app (wrangler dev) ---
const BASE = (process.env.API_TEST_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TEST_TOKEN ?? "test-admin-token";
// A route that is NOT gated runs its handler and hangs on the (absent) DB — treat a timeout as a failure.
const call = (path: string, init?: RequestInit) =>
  fetch(BASE + path, { ...init, signal: AbortSignal.timeout(5000) }).catch(() => new Response(null, { status: 599 }));

for (const r of routes) {
  const path = r.path.replace(/:(\w+)/g, "000000000000000000000000");
  for (const [label, headers] of [
    ["no token", {}],
    ["wrong token", { "X-Admin-Token": "nope" }],
  ] as const) {
    const res = await call(path, { method: r.method, headers });
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    check(`${r.method} ${r.path} (${label})`, res.status === 401 && body?.error?.code === "unauthorized", `got ${res.status}`);
  }
}

// --- the gate must not leak onto public routes ---
const health = await call("/health");
check("GET /health stays public", health.status === 200, `got ${health.status}`);
const version = await call("/api/version");
check("GET /api/version stays public", version.status === 200, `got ${version.status}`);

// --- a valid token gets past the gate (handler runs; with no DB it may 4xx/5xx, but never 401) ---
// --- a valid token reaches the handler: every GET admin route must exist (no 404) and pass the gate (no 401).
// GET only, so nothing writes or sends; with no DB the handler may 4xx/5xx/time out — that's fine here.
for (const r of routes.filter((x) => x.method === "GET")) {
  const res = await call(r.path.replace(/:(\w+)/g, "000000000000000000000000"), { headers: { "X-Admin-Token": TOKEN } });
  check(`GET ${r.path} (valid token)`, res.status !== 401 && res.status !== 404, `got ${res.status}`);
}

console.log(`${routes.length} admin routes × 2 unauth cases checked`);
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all admin auth checks passed");
