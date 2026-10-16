/**
 * HANDOFF_shop-tab-v1.md §2 — restock list. Read-only join of fridge_stock (needsRestock:true)
 * against canonical_ingredients/canonical_price_cache; no new price logic, `cheapest` is
 * already precomputed on canonical_price_cache by the cost engine's pipeline.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, ShopPricesStamp, ShopRestockItem } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const shopRouter = new Hono<{ Bindings: DbEnv }>();

shopRouter.get("/restock-list", async (c) => {
  try {
    const items = await withDb(c.env, async (db) => {
      const stockDocs = await db
        .collection("fridge_stock")
        .find({ userId: c.var.clerkUserId, needsRestock: true })
        .sort({ ingredientName: 1 })
        .toArray();

      const canonicalIds = stockDocs
        .map((d) => d.canonicalIngredientId as ObjectIdType | null)
        .filter((id): id is ObjectIdType => !!id);
      const canonicalDocs = canonicalIds.length
        ? await db.collection("canonical_ingredients").find({ _id: { $in: canonicalIds } }).toArray()
        : [];
      const canonicalNameById = new Map(canonicalDocs.map((d) => [(d._id as ObjectIdType).toString(), d.canonical_name as string]));

      const canonicalNames = [...new Set(canonicalNameById.values())];
      const priceDocs = canonicalNames.length
        ? await db.collection("canonical_price_cache").find({ canonical_name: { $in: canonicalNames } }).toArray()
        : [];
      const priceByCanonicalName = new Map(priceDocs.map((d) => [d.canonical_name as string, d as Document]));

      return stockDocs.map((doc): ShopRestockItem => {
        const canonicalId = doc.canonicalIngredientId as ObjectIdType | null;
        const canonicalName = canonicalId ? canonicalNameById.get(canonicalId.toString()) : undefined;
        const priceDoc = canonicalName ? priceByCanonicalName.get(canonicalName) : undefined;
        const cheapest = priceDoc?.cheapest as { store: string; price: number } | null | undefined;
        return {
          fridgeStockId: (doc._id as ObjectIdType).toString(),
          ingredientName: doc.ingredientName as string,
          quantity: doc.quantity as number,
          unit: doc.unit as string,
          cheapest: cheapest ? { store: cheapest.store, price: cheapest.price } : null,
          ...(canonicalName ? { canonicalName } : {}),
        };
      });
    });

    const body: ApiResponse<ShopRestockItem[]> = { ok: true, data: items };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shop restock-list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch restock list" } };
    return c.json(body, 502);
  }
});

/** Newest recipe_cost.priceCacheStamp — the Shop tab's "Prices checked <Mon YYYY>" note. Read-only, display only. */
shopRouter.get("/prices-stamp", async (c) => {
  try {
    const stamp = await withDb(c.env, async (db) => {
      const latest = await db
        .collection("recipe_cost")
        .find({}, { projection: { priceCacheStamp: 1 } })
        .sort({ priceCacheStamp: -1 })
        .limit(1)
        .toArray();
      const v = latest[0]?.priceCacheStamp;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    });
    const body: ApiResponse<ShopPricesStamp> = { ok: true, data: { priceCacheStamp: stamp } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shop prices-stamp error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch price date" } };
    return c.json(body, 502);
  }
});
