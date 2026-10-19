// Part B of cc_prompt_unpriced_lines_fix.md — Serper top-up for price-only docs (READ-ONLY on the DB; only spends Serper credits).
//   node scripts/unpriced_fix_fetch.cjs            -> ../../summaries/unpriced_fix_serper_<date>.json
// Raw whitelisted UK-supermarket listings per query are stored so the dry-run / write steps never call Serper again.
// Same request as price_refresh.cjs serperShopping(): POST google.serper.dev/shopping { q, gl: "gb", location: "United Kingdom" }.
const fs = require("fs");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(API_ROOT, "../../summaries", `unpriced_fix_serper_${new Date().toISOString().slice(0, 10)}.json`);
const UK = ["tesco", "sainsbury", "asda", "morrisons", "waitrose", "ocado", "iceland", "co-op", "coop", "aldi", "lidl"];
const BLOCK = ["amazon", "ebay"];

// canonical -> queries (<= 2 each). Cloud Part B examples first; the rocket / yogurt / aubergine ones use the UK names.
const QUERIES = {
  "sesame seeds (for garnish)": ["sesame seeds 100g price", "sesame seeds 250g price"],
  "fresh ginger": ["fresh root ginger loose price", "root ginger 100g price"],
  "ancho chile powder": ["ancho chilli powder 50g price", "ancho chilli powder price"],
  "arborio rice": ["arborio risotto rice 500g price", "arborio rice 1kg price"],
  eggplant: ["aubergine each price", "aubergine 1 each"],
  arugula: ["wild rocket 65g price", "baby rocket salad 60g price"],
};

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.join(API_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

(async () => {
  const key = process.env.SERPER_API_KEY || loadDevVars().SERPER_API_KEY;
  if (!key) throw new Error("no SERPER_API_KEY");
  const result = { generatedAt: new Date().toISOString(), calls: 0, credits: 0, byCanonical: {} };
  for (const [canonical, queries] of Object.entries(QUERIES)) {
    result.byCanonical[canonical] = [];
    for (const q of queries) {
      const resp = await fetch("https://google.serper.dev/shopping", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q, gl: "gb", location: "United Kingdom" }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Serper HTTP ${resp.status}: ${text.slice(0, 160)}`);
      const body = JSON.parse(text);
      const shopping = Array.isArray(body.shopping) ? body.shopping : [];
      result.calls += 1;
      result.credits += typeof body.credits === "number" ? body.credits : 0;
      const uk = shopping.filter((s) => {
        const src = String(s.source || "").toLowerCase();
        return !BLOCK.some((b) => src.includes(b)) && UK.some((u) => src.includes(u));
      });
      result.byCanonical[canonical].push({
        q, serperResults: shopping.length, credits: body.credits ?? null,
        listings: uk.map((s) => ({ store: s.source, title: s.title, price: s.price })),
      });
      console.log(`${canonical} | ${q} | raw ${shopping.length} uk ${uk.length}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`calls ${result.calls} credits ${result.credits} -> ${OUT}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
