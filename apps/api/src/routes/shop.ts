/**
 * HANDOFF_shop-tab-v1.md §2 — restock list. Read-only join of fridge_stock (needsRestock:true)
 * against canonical_ingredients/canonical_price_cache; no new price logic, `cheapest` is
 * already precomputed on canonical_price_cache by the cost engine's pipeline.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, ShopRestockItem } from "@uiu/shared";
import { withDb, type DbEnv } from "../db";

export const shopRouter = new Hono<{ Bindings: DbEnv }>();

shopRouter.get("/restock-list", async (c) => {
  try {
    const items = await withDb(c.env, async (db) => {
      const stockDocs = await db
        .collection("fridge_stock")
        .find({ needsRestock: true })
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
