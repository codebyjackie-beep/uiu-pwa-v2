// npx tsx src/services/canonicalPriceSeed.test.ts — guard on the listings stored in "single cream (_milk_)" (Atlas, 2026-11-03 refresh)
import { evaluateSeed } from "./canonicalPriceSeed";

let fail = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
};

const listings = [
  { store: "Asda Groceries", title: "ASDA Fresh Single Cream 300ml", price: 1.35 },
  { store: "Waitrose & Partners", title: "Essential Waitrose Single Cream", price: 0.95 },
  { store: "sainsburys.co.uk", title: "Sainsbury's British Single", price: 1.35 },
  { store: "Tesco", title: "Creamfields Single Cream 300Ml", price: 1.09 },
  { store: "Ocado", title: "M&S British Single Cream, 150ml", price: 0.95 },
  { store: "sainsburys.co.uk", title: "Sainsbury's British Single Fresh", price: 2.25 },
  { store: "Waitrose & Partners", title: "essential Waitrose single cream", price: 2.35 },
  { store: "Ocado", title: "Ocado British Single Cream", price: 1.35 },
  { store: "sainsburys.co.uk", title: "Graham's Gold Smooth Jersey Milk", price: 1.95 },
  { store: "Morrisons.com", title: "Morrisons British Semi Skimmed Milk", price: 0.85 },
];
const ev = evaluateSeed({ canonical_name: "single cream", aliases: [] }, listings, { label: "copy:single cream (_milk_)", attempts: null });
eq("decision", ev.decision.action, "update");
eq("per_unit_metric", ev.g.per_unit_metric, { value: 0.0045, unit: "g_or_ml", n: 3 });
eq("milk listings dropped", ev.dropped.map((d) => d.title).sort(), ["Graham's Gold Smooth Jersey Milk", "Morrisons British Semi Skimmed Milk"]);
eq("no milk in kept", ev.kept.some((k) => /milk/i.test(String(k.title))), false);
eq("cheapest is cream", /cream/i.test(String((ev.g.cheapest as { title?: string })?.title)), true);
eq("doc name", ev.doc?.canonical_name, "single cream");
eq("doc metadata.source", (ev.doc?.metadata as { source?: string })?.source, "serper");
eq("doc seed_source", (ev.doc?.metadata as { seed_source?: string })?.seed_source, "copy:single cream (_milk_)");
eq("doc has no non-standard top-level keys", Object.keys(ev.doc ?? {}).filter((k) => !["canonical_name", "per_unit_metric", "per_unit_count", "cheapest", "n_supermarkets", "listings", "confidence", "needs_review", "metadata"].includes(k)), []);
eq("one listing only -> hold", evaluateSeed({ canonical_name: "single cream" }, listings.slice(0, 1), { label: "x", attempts: 1 }).doc, null);
const prodCanon = { canonical_name: "single cream", aliases: ["single cream", "single cream (_milk_)"] }; // Atlas 2026-11-09
const ev2 = evaluateSeed(prodCanon, listings, { label: "copy:single cream (_milk_)", attempts: null });
eq("markup alias does not let milk through", ev2.dropped.map((d) => d.title).sort(), ["Graham's Gold Smooth Jersey Milk", "Morrisons British Semi Skimmed Milk"]);
eq("markup alias: cheapest is cream", /cream/i.test(String((ev2.g.cheapest as { title?: string })?.title)), true);
eq("markup alias: metric", ev2.g.per_unit_metric, { value: 0.0045, unit: "g_or_ml", n: 3 });
if (fail) throw new Error(`${fail} failed`);
console.log("all passed");
