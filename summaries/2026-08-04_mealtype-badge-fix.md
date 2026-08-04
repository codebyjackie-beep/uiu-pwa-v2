# mealTypeBadge() 修正報告 — 2026-08-04

## 背景

Task B 診斷（見 `2026-08-04_batch-tasks.md`）確認：`apps/web/app/lib/recipeDisplay.ts` 嘅 `mealTypeBadge()` 淨係揀 `recipe.tags` array 入面第一個撞到 `MEAL_TYPES` 嘅字做顯示，取決於 DB 存 tag 嘅隨機次序，同真正決定 filter 撞唔撞到嘅 `apps/web/app/lib/recipeFilters.ts` `classifyMealTypes()` 完全冇關，導致「filter 揀啱，badge 顯示亂」。

## 改咗咩

`apps/web/app/lib/recipeDisplay.ts`：

- `mealTypeBadge()` 唔再自己 `.find()` tags，改為內部呼叫 `classifyMealTypes({ title, tags })`（`recipeFilters.ts`）攞返個 `Set<FilterMealType>`。
- `classifyMealTypes()` 可能同時 return 多個 slot（例如 `brunch` tag 令 `breakfast`+`lunch` 同時喺 set 度），加咗固定優先順序 `BADGE_PRIORITY = ["breakfast", "lunch", "dinner", "snack", "dessert"]` 揀第一個中嘅 slot 做 badge——`brunch` tag 而家會優先顯示 **Breakfast**。
- `recipe.mealType` 呢個 explicit override 分支（第一個 `if`）完全冇郁——meal-plan entry 自己記低嘅實際 slot，同呢次改動無關。
- Type 層面：`MealTagged` interface 加咗 `title: string`（`classifyMealTypes()` 需要）。Check 咗 3 個呼叫位（`MealPlannerBoard.tsx` 傳 `RecipeListItem`、`RecipesBrowser.tsx` 傳 `RecipeListItem`、`recipes/[id]/page.tsx` 傳 `RecipeDetail`）——兩個 type 都有 `title: string`，`tsc --noEmit` 全部通過，冇改呼叫位。

冇改 `recipeFilters.ts`（filter 邏輯本身冇問題，呢次純粹令 badge 跟返佢）。

## Production 驗證

用真實 production `recipes` collection 嘅 title/tags，跑一份同新 code 邏輯完全一致嘅 JS port（跑完即刪，冇留低任何 script 喺 repo）：

**Task B 4 條診斷 recipe（全部有 `breakfast` tag，而家應該一致顯示 Breakfast）：**

| Recipe | 新 badge | filter slots |
|---|---|---|
| Butternut Squash Frittata | **Breakfast** | lunch, breakfast, dinner |
| Chicken Porridge | **Breakfast** | breakfast, lunch |
| Crab Cakes Eggs Benedict | **Breakfast** | breakfast, dessert |
| Finger Foods: Frittata Muffins | **Breakfast** | breakfast, dessert |

全部一致顯示 Breakfast，同 `/recipes` 頁 Breakfast filter（用 `classifyMealTypes()` 判斷、呢 4 條全部有 `breakfast` slot）結果對得上——「filter 揀啱，badge 顯示亂」嘅 gap 冚咗。

（Crab Cakes / Finger Foods 個 filterSlots 多咗個 `dessert`——嗰個係 `DESSERT_KEYWORDS` 撞到 "cakes"/"muffin" 呢類字眼嘅獨立、pre-existing 行為，同呢次 badge fix 無關，`BADGE_PRIORITY` 令 breakfast 優先顯示，冇影響。）

**5 條純 lunch/dinner recipe（冇 `breakfast`/`brunch` tag，confirm 冇被累到）：**

| Recipe | badge | filter slots |
|---|---|---|
| Pesto & Yogurt Pasta | Lunch | lunch, dinner |
| Garlic Lime Grilled Chicken Salad | Lunch | lunch, dinner |
| Chicken Rou Zao With Rice | Lunch | lunch, dinner |
| Moosewood Lentil Soup | Lunch | lunch |
| Avocado Tomato & Mozzarella Panini | Lunch | lunch, dinner |

全部同之前行為一致（`lunch` tag 優先顯示 Lunch），冇任何 regression。

`tsc --noEmit` 喺 `apps/web` 全 project 通過，冇 type error。

## Commit

`apps/web/app/lib/recipeDisplay.ts` 一個檔案改動，已 commit + push 上 `main`。

## 狀態

✅ 完成，已用真實 production 數據驗證（4 條 bug recipe + 5 條 sanity check recipe），冇留低任何測試/臨時 script 喺 repo。等 Jackie 逐份驗證。
