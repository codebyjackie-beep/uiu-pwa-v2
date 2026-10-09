# 2026-08-13 — Recipe Image Backfill: Write + Title Cleanup

Implemented `HANDOFF_recipe-image-backfill.md` §2 (write step), plus two follow-up asks from Jackie: exclude one bad Pexels match, and clean up a stray test-artifact title.

Commits: `a5fc343` (backfill-images endpoint), `850443a` (skipIds param). Deployed twice — final `apps/api` Version ID `65abdbbf-20fe-495f-b5f3-1bc1621a2253`. `npx tsc --noEmit` clean in `apps/api` before each deploy.

---

## 1. Write run — 16 written, 1 skipped, 0 errors

Ran with the taco mismatch excluded via the new `skipIds` param:
```
POST /api/admin/recipes/backfill-images?write=true&skipIds=6a7514362ba18e08ad720e80
```
Full raw output: `summaries/2026-08-13_recipe-image-backfill-write.json`.

```json
{ "dryRun": false, "totalMissing": 17, "found": 16, "notFound": 0, "skipped": 1 }
```
No 429s, no errors, no `not_found` outcomes. Every one of the 16 non-skipped recipes returned the same Pexels URL as the earlier dry-run (`summaries/2026-08-13_recipe-image-backfill-dryrun.json`) — the search is deterministic per title, so write reused those exact matches rather than re-rolling.

**Why skip instead of relying on outcome alone:** the dry-run's match for "Charred Corn and Avocado Salsa with Lime-Roasted Jicama" was Pexels photo `4958778`, captioned "A Person Holding a Taco" — unrelated to the dish. Rather than trust a second `findRecipePhoto()` call to coincidentally return something different, the endpoint now takes a `skipIds` query param (comma-separated recipe ids) that hard-excludes those ids from ever being written, regardless of what Pexels returns for them. The skipped recipe's `outcome` is reported as `"skipped"`, not `"found"`/`"not_found"`.

## 2. Raw DB verification — all 17 checked directly

Queried `recipes` for all 17 ids by `_id`, projecting `title`/`imageUrl`:

| id | title | imageUrl | check |
|---|---|---|---|
| 69d051fa50df0636d9bd2c14 | Classic Tomato Bruschetta | images.pexels.com/photos/7432991/... | OK |
| 6a69323fb048d5e7f4ddfb31 | One-Tray Honey Mustard Chicken Thighs with New Potatoes | images.pexels.com/photos/37228290/... | OK |
| 6a6cfa88901ee72fdac2149f | Tuscan Broccolini Quinoa Pilaf with Lemon, Herbs, and Goat Cheese | images.pexels.com/photos/21531727/... | OK |
| 6a6cfaa3901ee72fdac214a1 | Goldilocks Vanilla Chia Quinoa Breakfast Porridge | images.pexels.com/photos/27850092/... | OK |
| 6a6cfaa4901ee72fdac214a3 | Raspberry Arugula Bites with Goat Cheese and Bacon | images.pexels.com/photos/251599/... | OK |
| 6a6cfaa5901ee72fdac214a5 | Spring Meadow Keto Frittata | images.pexels.com/photos/5639255/... | OK |
| 6a6cfaa5901ee72fdac214a7 | Goldilocks Coconut Chia Breakfast Porridge | images.pexels.com/photos/27850095/... | OK |
| 6a6cfaa6901ee72fdac214a9 | Lemon-Dill Salmon Breakfast Frittata | images.pexels.com/photos/38544360/... | OK |
| 6a711d7f401468e5cba9701d | **British Mushroom and Lentil Cottage Pie** (title fixed, see §3) | images.pexels.com/photos/15655219/... | OK |
| 6a7125a91ee1eaaddd32d6f5 | Chilled Andalusian Tomato-Cucumber Soup with Green Herb Swirl | images.pexels.com/photos/36430086/... | OK |
| 6a7127e01ce6ee40ea4dd659 | Sesame-Ginger Chinese Chicken Salad with Quail Egg Crunch | images.pexels.com/photos/28618639/... | OK |
| 6a724c34839c335789cfe29d | Miso Noodle Soup with Mushrooms and Greens | images.pexels.com/photos/27009849/...**.png** | OK |
| 6a750fc40d9d66e08011e8b7 | Silken Miso Noodle Soup with Ginger and Greens | images.pexels.com/photos/17593641/... | OK |
| 6a7511c23f26e2492feeb982 | Crisp Ginger Chicken and Cabbage Salad with Sesame Rice Noodles | images.pexels.com/photos/2116090/... | OK |
| **6a7514362ba18e08ad720e80** | Charred Corn and Avocado Salsa with Lime-Roasted Jicama | **`""` (empty — confirmed NOT written)** | OK |
| 6a75188a7a409c2c73f12b47 | Caprese-Stuffed Tomato and Mozzarella Toasts with Basil Oil | images.pexels.com/photos/24554392/... | OK |
| 6a751a4e526cdce47ad48561 | Red Quinoa Tabbouleh-Style Salad with Cucumber, Herbs, and Sumac | images.pexels.com/photos/37976941/... | OK |

All 16 written recipes: `imageUrl` starts with `https://images.pexels.com`. The taco-match recipe (`6a7514362ba18e08ad720e80`): `imageUrl` is still `""` — confirmed **not** overwritten with photo `4958778`.

## 3. Title cleanup — `6a711d7f401468e5cba9701d`

**Root cause:** traced via `summaries/2026-08-04_recipe-drafts-admin-login.md` §3–4. On 2026-08-04, a prior CC session used this recipe as the live test subject for verifying the admin `PATCH /api/admin/recipe-drafts/:id` endpoint — it deliberately renamed the draft's title to `"British Mushroom and Lentil Cottage Pie (CC verify edit)"` and appended a `smoked paprika` ingredient line as a visible marker that the PATCH round-tripped correctly, then approved the draft into a live recipe to also verify the approve flow carried the edit through. The verification never included a revert step, so the marker text shipped into production and sat there for 9 days.

**Before → after:**
```
"British Mushroom and Lentil Cottage Pie (CC verify edit)"
  → "British Mushroom and Lentil Cottage Pie"
```
Fixed via `PATCH /api/admin/recipes/6a711d7f401468e5cba9701d` (the intended edit-a-live-recipe endpoint — not a direct DB write), same auth convention as the rest of the admin surface.

**Cache/copy check:** searched every collection that could plausibly reference this recipe by id or embed its title —`recipe_cost` (no `title` field at all, only `recipeId`/lines/pricing — nothing to update), `meal_plans`, `meal_plan_sets`, `favourite_recipes`, `shopping_list_items`, `fridge_stock` — **0 matches** in all of them. This recipe has never been added to a meal plan, favourited, or referenced in a shopping list, so the title only ever lived in the one `recipes` doc. No other update needed.

**Known, separate, unresolved:** the same test edit also appended a `{"name":"smoked paprika","quantity":1,"unit":"tsp"}` ingredient line, which is **still present** — this was outside what was asked (title only) and wasn't touched. Flagging for Jackie to decide whether to also strip it; it's a real ingredient (not garbage), just a 2026-08-04 test addition that happened to make it into production alongside the title marker.

## 4. Render check — 3 recipes, WebFetch against live pages

| URL | Title shown | Image src rendered |
|---|---|---|
| `useitup.uk/recipes/6a711d7f401468e5cba9701d` | "British Mushroom and Lentil Cottage Pie" (clean, no residue) | `images.pexels.com/photos/15655219/...` |
| `useitup.uk/recipes/6a6cfa88901ee72fdac2149f` | "Tuscan Broccolini Quinoa Pilaf with Lemon, Herbs, and Goat Cheese" | `images.pexels.com/photos/21531727/...` |
| `useitup.uk/recipes/6a724c34839c335789cfe29d` | "Miso Noodle Soup with Mushrooms and Greens" | `images.pexels.com/photos/27009849/...png` |

All 3 render an `<img>` with the expected Pexels URL and the correct title.

---

## Outstanding for Jackie

- **Charred Corn and Avocado Salsa with Lime-Roasted Jicama** (`6a7514362ba18e08ad720e80`) still has no image — needs a manual pick or a title tweak to get a better Pexels match, per the handoff's V1 scope (no auto-retry with a different keyword).
- **Smoked paprika ingredient** on the Cottage Pie recipe — 2026-08-04 test artifact, still live, not removed (out of this task's scope; flagging only).
