/**
 * HANDOFF_shop-tab-v1.md §3 — manual shopping list items (collection: shopping_list_items).
 * Not tied to canonical_ingredients — no price match in V1. Deletable outright (unlike
 * fridge_stock, a manual item doesn't need a history trail once bought).
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, ShoppingListItem } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";

export const shoppingListRouter = new Hono<{ Bindings: DbEnv }>();

function toShoppingListItem(doc: Document): ShoppingListItem {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    text: doc.text as string,
    checked: !!doc.checked,
    addedAt: doc.addedAt as string,
  };
}

shoppingListRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) => db.collection("shopping_list_items").find({}).sort({ addedAt: 1 }).toArray());
    const body: ApiResponse<ShoppingListItem[]> = { ok: true, data: docs.map(toShoppingListItem) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch shopping_list_items" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const text = payload?.text as string | undefined;
  if (typeof text !== "string" || !text.trim()) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "text is required" } };
    return c.json(body, 400);
  }

  try {
    const doc = { text: text.trim(), checked: false, addedAt: new Date().toISOString() };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("shopping_list_items").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<ShoppingListItem> = { ok: true, data: toShoppingListItem(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] shopping-list create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to add shopping_list_item" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.patch("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid shopping_list_item id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload.checked !== "boolean") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "checked (boolean) is required" } };
    return c.json(body, 400);
  }

  try {
    const result = await withDb(c.env, (db) =>
      db.collection("shopping_list_items").findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checked: payload.checked } }, { returnDocument: "after" }),
    );
    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "shopping_list_item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<ShoppingListItem> = { ok: true, data: toShoppingListItem(result) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update shopping_list_item" } };
    return c.json(body, 502);
  }
});

shoppingListRouter.delete("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid shopping_list_item id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("shopping_list_items").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "shopping_list_item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] shopping-list delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete shopping_list_item" } };
    return c.json(body, 502);
  }
});
