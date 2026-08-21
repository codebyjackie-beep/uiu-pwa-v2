/**
 * HANDOFF_fridge.md — fridge_stock CRUD. No auth (same convention as
 * recipes/meal_plans — this isn't an admin-only surface).
 */
import { Hono, type Context } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, FridgeStockItem, FridgeStockSource } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { estimateExpiresAt } from "../services/shelfLife";
import { scanImageForItems, type OpenRouterVisionEnv, type ScannedItem } from "../services/openrouterVision";

type FridgeStockEnv = DbEnv & OpenRouterVisionEnv;

export const fridgeStockRouter = new Hono<{ Bindings: FridgeStockEnv }>();

const VALID_SOURCES: FridgeStockSource[] = ["manual", "ocr", "shop-auto", "photo-scan"];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function fileToDataUrl(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const base64 = btoa(binary);
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${base64}`;
}

async function handleImageScan(c: Context<{ Bindings: FridgeStockEnv }>, prompt: string) {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.image;
  if (!(file instanceof File)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "multipart/form-data with an 'image' file field is required" } };
    return c.json(body, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Image too large (max 8MB)" } };
    return c.json(body, 400);
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    const items = await scanImageForItems(c.env, dataUrl, prompt);
    const body: ApiResponse<ScannedItem[]> = { ok: true, data: items };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock image scan error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "vision_error", message: "Failed to analyze image" } };
    return c.json(body, 502);
  }
}

function toFridgeStockItem(doc: Document): FridgeStockItem {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    ingredientName: doc.ingredientName as string,
    canonicalIngredientId: doc.canonicalIngredientId ? (doc.canonicalIngredientId as ObjectIdType).toString() : null,
    quantity: doc.quantity as number,
    unit: doc.unit as string,
    addedAt: doc.addedAt as string,
    expiresAt: doc.expiresAt as string,
    expiresAtIsManualOverride: !!doc.expiresAtIsManualOverride,
    source: doc.source as FridgeStockSource,
    needsRestock: !!doc.needsRestock,
  };
}

/** For the manual-add form's ingredient picker — name + is_pantry only, matches
 * MealTagPicker's "small enough to fetch once, filter client-side" approach
 * (canonical_ingredients is 741 docs). */
fridgeStockRouter.get("/ingredient-options", async (c) => {
  try {
    const options = await withDb(c.env, (db) =>
      db
        .collection("canonical_ingredients")
        .find({}, { projection: { canonical_name: 1, is_pantry: 1 } })
        .toArray(),
    );
    const body: ApiResponse<{ id: string; name: string; isPantry: boolean }[]> = {
      ok: true,
      data: options.map((d) => ({ id: (d._id as ObjectIdType).toString(), name: d.canonical_name as string, isPantry: !!d.is_pantry })),
    };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock ingredient-options error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch ingredient options" } };
    return c.json(body, 502);
  }
});

fridgeStockRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) => db.collection("fridge_stock").find({}).sort({ expiresAt: 1 }).toArray());
    const body: ApiResponse<FridgeStockItem[]> = { ok: true, data: docs.map(toFridgeStockItem) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock list error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch fridge_stock" } };
    return c.json(body, 502);
  }
});

fridgeStockRouter.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const ingredientName = payload?.ingredientName as string | undefined;
  const quantity = Number(payload?.quantity);
  const unit = payload?.unit as string | undefined;
  const source = payload?.source as string | undefined;
  const canonicalIngredientId = payload?.canonicalIngredientId as string | null | undefined;

  if (
    typeof ingredientName !== "string" ||
    !ingredientName.trim() ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    typeof unit !== "string" ||
    !unit.trim() ||
    !source ||
    !VALID_SOURCES.includes(source as FridgeStockSource)
  ) {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: `ingredientName, quantity (>0), unit, and source (one of ${VALID_SOURCES.join(", ")}) are required` },
    };
    return c.json(body, 400);
  }

  try {
    const { ObjectId } = await getMongoModule();
    let canonicalId: ObjectIdType | null = null;
    let isPantry = false;
    if (typeof canonicalIngredientId === "string" && canonicalIngredientId) {
      if (!ObjectId.isValid(canonicalIngredientId)) {
        const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid canonicalIngredientId" } };
        return c.json(body, 400);
      }
      canonicalId = new ObjectId(canonicalIngredientId);
    }

    const now = new Date();
    const inserted = await withDb(c.env, async (db) => {
      if (canonicalId) {
        const canonicalDoc = await db.collection("canonical_ingredients").findOne({ _id: canonicalId });
        isPantry = !!canonicalDoc?.is_pantry;
      }
      const doc = {
        ingredientName: ingredientName.trim(),
        canonicalIngredientId: canonicalId,
        quantity,
        unit: unit.trim(),
        addedAt: now.toISOString(),
        expiresAt: estimateExpiresAt(isPantry, now),
        expiresAtIsManualOverride: false,
        source,
        needsRestock: false,
      };
      const result = await db.collection("fridge_stock").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });

    const body: ApiResponse<FridgeStockItem> = { ok: true, data: toFridgeStockItem(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] fridge-stock create error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to add fridge_stock item" } };
    return c.json(body, 502);
  }
});

fridgeStockRouter.patch("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid fridge_stock id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "JSON body required" } };
    return c.json(body, 400);
  }

  const update: Document = {};
  if (payload.quantity !== undefined) {
    const quantity = Number(payload.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "quantity must be a positive number" } };
      return c.json(body, 400);
    }
    update.quantity = quantity;
  }
  if (payload.expiresAt !== undefined) {
    if (typeof payload.expiresAt !== "string" || Number.isNaN(new Date(payload.expiresAt).getTime())) {
      const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "expiresAt must be a valid ISO date string" } };
      return c.json(body, 400);
    }
    update.expiresAt = payload.expiresAt;
    update.expiresAtIsManualOverride = true;
  }
  if (payload.needsRestock !== undefined) {
    update.needsRestock = !!payload.needsRestock;
  }
  if (Object.keys(update).length === 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "No editable fields in body (quantity, expiresAt, needsRestock)" } };
    return c.json(body, 400);
  }

  try {
    const result = await withDb(c.env, async (db) => {
      const updated = await db
        .collection("fridge_stock")
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: update }, { returnDocument: "after" });
      return updated;
    });
    if (!result) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "fridge_stock item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<FridgeStockItem> = { ok: true, data: toFridgeStockItem(result) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update fridge_stock item" } };
    return c.json(body, 502);
  }
});

fridgeStockRouter.delete("/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid fridge_stock id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("fridge_stock").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "fridge_stock item not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete fridge_stock item" } };
    return c.json(body, 502);
  }
});

/**
 * HANDOFF_fridge-followup.md #2 — receipt OCR. Analysis-only: returns the
 * scanned items for the client to review/edit, does NOT write to fridge_stock.
 * The client confirms via the normal POST / (one call per confirmed item).
 */
fridgeStockRouter.post("/ocr", (c) =>
  handleImageScan(
    c,
    "Read this shopping receipt. List ONLY the food and grocery items purchased — exclude non-food " +
      "items entirely (e.g. toiletries, cleaning products, toothpaste, tissue/toilet paper, medicine, " +
      "pet supplies, batteries, stationery, kitchenware/homeware). If an item is ambiguous or you are " +
      "unsure whether it is food, leave it out rather than guessing. " +
      'UK till receipts heavily abbreviate product names — e.g. "MOISTRSNG"=Moisturising, ' +
      '"CL"=Cleanser, "LTN"=Lotion, "SHMPOO"=Shampoo, "COND"=Conditioner, "DEO"=Deodorant, ' +
      '"TOOTHPST"=Toothpaste. Also watch for known personal-care/skincare/haircare brand ' +
      "names even without a category word (e.g. Simple, Nivea, Dove, Vaseline, Sensodyne, " +
      "Colgate, Original Source, Radox, Imperial Leather) — these are never food regardless " +
      "of what follows. When a line's meaning is unclear because of abbreviation, lean " +
      "toward excluding it rather than including it — a missed grocery item is far less " +
      "harmful than a toiletry ending up in a food list. " +
      "For each remaining item give its " +
      'name and quantity if visible. Respond with ONLY a JSON array, no markdown fences, no commentary: ' +
      '[{"name": string, "quantity": number|null}].',
  ),
);

/**
 * HANDOFF_fridge-followup.md #4 — fridge photo scan. Same analysis-only,
 * confirm-before-write contract as /ocr above, just a different prompt.
 */
fridgeStockRouter.post("/scan-fridge", (c) =>
  handleImageScan(
    c,
    "List the distinct food items visible in this fridge photo. For each, give a short name and, if visible, " +
      'an approximate quantity. Respond with ONLY a JSON array, no markdown fences, no commentary: [{"name": string, "quantity": number|null}].',
  ),
);
