/**
 * spoonacular_browse.cjs — Spoonacular (via RapidAPI) idea browser (2026-07-28)
 *
 * 用途：睇 Spoonacular complexSearch 有咩 dish idea，俾 Jackie 揀橋去人手/AI 原創寫 recipe。
 * 唔係 import pipeline——response 淨係 console.log，唔寫任何檔案/DB/cache。
 * 跟 HANDOFF_ai-recipe-drafting-tool.md Part A：淨係要 title/summary(截短)/diet/cuisine，
 * 唔 pull ingredients/instructions（ToS 唔准長期存呢啲）。Basic tier 400 results/40 requests
 * 一日，設計俾 Jackie 一次揀 3-5 個 keyword 手動跑，唔係 batch/自動化 bulk 工具。
 *
 * 跑法（喺 uiu-pwa-v2\ 或 repo 任何地方）：
 *   node tools/recipe_ideas/spoonacular_browse.cjs --query="keto dinner" --diet=ketogenic --number=5
 *
 * 支援參數：--query（必要）--diet --cuisine --number（default 5, cap 10）
 */
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.resolve(__dirname, '..', '..', '..', 'Key', 'spoonacular-rapidapi-key.txt');
const KEY_RAW = fs.readFileSync(KEY_FILE, 'utf8');
const HOST_MATCH = KEY_RAW.match(/x-rapidapi-host:\s*(\S+)/i);
const KEY_MATCH = KEY_RAW.match(/x-rapidapi-key:\s*(\S+)/i);
if (!HOST_MATCH || !KEY_MATCH) {
  throw new Error(`Could not parse x-rapidapi-host / x-rapidapi-key from ${KEY_FILE}`);
}
const RAPIDAPI_HOST = HOST_MATCH[1];
const RAPIDAPI_KEY = KEY_MATCH[1];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '').trim();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node spoonacular_browse.cjs --query="keto dinner" [--diet=ketogenic] [--cuisine=asian] [--number=5]');
    process.exit(1);
  }
  const number = Math.min(Number(args.number) || 5, 10);

  const url = new URL(`https://${RAPIDAPI_HOST}/recipes/complexSearch`);
  url.searchParams.set('query', args.query);
  if (args.diet) url.searchParams.set('diet', args.diet);
  if (args.cuisine) url.searchParams.set('cuisine', args.cuisine);
  url.searchParams.set('number', String(number));
  url.searchParams.set('addRecipeInformation', 'true');

  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
  });

  if (!res.ok) {
    console.error(`Request failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const json = await res.json();
  const results = json.results || [];

  console.log(`\nQuery: "${args.query}"${args.diet ? ` | diet=${args.diet}` : ''}${args.cuisine ? ` | cuisine=${args.cuisine}` : ''}`);
  console.log(`${results.length} idea(s):\n`);

  for (const r of results) {
    console.log(`- ${r.title}`);
    if (r.cuisines && r.cuisines.length) console.log(`  cuisine: ${r.cuisines.join(', ')}`);
    if (r.diets && r.diets.length) console.log(`  diet: ${r.diets.join(', ')}`);
    if (r.summary) console.log(`  summary: ${truncate(stripHtml(r.summary), 200)}`);
    console.log('');
  }

  console.log('(response 用完即棄 — 冇寫落任何檔案/DB/cache，process 完全冇留低 trace。)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
