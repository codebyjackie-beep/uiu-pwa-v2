/**
 * Recipe JSON-LD helper — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/web/app/lib/recipeJsonLd.test.ts
 */
import { buildRecipeJsonLd, isoDuration, serializeJsonLd, type RecipeJsonLdInput } from "./recipeJsonLd";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, detail ?? "");
  }
}

const full: RecipeJsonLdInput = {
  _id: "6650a1b2c3d4e5f6a7b8c9d0",
  title: "Red Lentil Soup",
  description: "A quick, warming soup.",
  isPublic: true,
  imageUrl: "https://images.example.com/soup.jpg",
  servings: 4,
  prepTimeMinutes: 10,
  cookTimeMinutes: 80,
  steps: ["Chop the onion.", "  Simmer for 20 minutes. "],
  ingredientLines: ["200g Red lentils", "1 pc Onion"],
};

// isoDuration
check("iso: 45 → PT45M", isoDuration(45) === "PT45M");
check("iso: 90 → PT1H30M", isoDuration(90) === "PT1H30M");
check("iso: 120 → PT2H", isoDuration(120) === "PT2H");

// full recipe
const ld = buildRecipeJsonLd(full)!;
check("full: not null", ld !== null);
check("full: @context", ld["@context"] === "https://schema.org");
check("full: @type Recipe", ld["@type"] === "Recipe");
check("full: name", ld.name === "Red Lentil Soup");
check("full: url is canonical absolute", ld.url === "https://useitup.uk/recipes/red-lentil-soup-6650a1b2c3d4e5f6a7b8c9d0", ld.url);
check("full: mainEntityOfPage = url", ld.mainEntityOfPage === ld.url);
check("full: image", JSON.stringify(ld.image) === JSON.stringify(["https://images.example.com/soup.jpg"]), ld.image);
check("full: recipeYield", ld.recipeYield === "4 servings", ld.recipeYield);
check("full: prepTime", ld.prepTime === "PT10M");
check("full: cookTime", ld.cookTime === "PT1H20M", ld.cookTime);
check("full: totalTime", ld.totalTime === "PT1H30M", ld.totalTime);
check("full: recipeIngredient", JSON.stringify(ld.recipeIngredient) === JSON.stringify(["200g Red lentils", "1 pc Onion"]));
check(
  "full: HowToStep, trimmed",
  JSON.stringify(ld.recipeInstructions) ===
    JSON.stringify([
      { "@type": "HowToStep", text: "Chop the onion." },
      { "@type": "HowToStep", text: "Simmer for 20 minutes." },
    ]),
  ld.recipeInstructions,
);
check("full: author is UseItUp org", JSON.stringify(ld.author) === JSON.stringify({ "@type": "Organization", name: "UseItUp", url: "https://useitup.uk" }));
for (const k of ["aggregateRating", "review", "video", "nutrition", "offers", "price", "estimatedCost"]) {
  check(`full: no ${k}`, !(k in ld));
}
check("single serving: '1 serving'", buildRecipeJsonLd({ ...full, servings: 1 })!.recipeYield === "1 serving");

// missing fields omitted
const bare = buildRecipeJsonLd({ _id: "abc", title: "Toast", isPublic: true, description: "  ", imageUrl: "", servings: 0, prepTimeMinutes: 0, cookTimeMinutes: 0, steps: [], ingredientLines: [" "] })!;
for (const k of ["description", "image", "recipeYield", "prepTime", "cookTime", "totalTime", "recipeIngredient", "recipeInstructions"]) {
  check(`bare: ${k} omitted`, !(k in bare), bare[k]);
}
const onlyCook = buildRecipeJsonLd({ ...full, prepTimeMinutes: 0, cookTimeMinutes: 25 })!;
check("only cook: no prepTime", !("prepTime" in onlyCook));
check("only cook: totalTime = cook", onlyCook.totalTime === "PT25M");
check("relative image omitted", !("image" in buildRecipeJsonLd({ ...full, imageUrl: "/og-image.png" })!));
check("non-http image omitted", !("image" in buildRecipeJsonLd({ ...full, imageUrl: "javascript:alert(1)" })!));

// non-public / not found → null
check("isPublic false → null", buildRecipeJsonLd({ ...full, isPublic: false }) === null);
check("isPublic missing → null", buildRecipeJsonLd({ ...full, isPublic: undefined }) === null);
check("null input → null", buildRecipeJsonLd(null) === null);
check("empty title → null", buildRecipeJsonLd({ ...full, title: "  " }) === null);

// escaping
const evil = buildRecipeJsonLd({ ...full, title: "Soup</script><script>alert(1)</script>", steps: ["a < b \u2028 c"] })!;
const s = serializeJsonLd(evil);
check("escape: no raw '<' in output", !s.includes("<"), s);
check("escape: no '</script' in output", !s.toLowerCase().includes("</script"), s);
check("escape: no raw U+2028", !s.includes("\u2028"));
const raw = serializeJsonLd({ text: "x\u2028y\u2029z" });
check("escape: U+2028/2029 escaped by serializer", !raw.includes("\u2028") && !raw.includes("\u2029") && raw.includes("\\u2028"), raw);
check("escape: round-trips to same data", JSON.stringify(JSON.parse(s)) === JSON.stringify(evil));

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
