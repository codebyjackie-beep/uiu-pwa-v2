/**
 * HANDOFF_fridge.md — fridge_stock CRUD. Per-user (Milestone 2): requireClerkAuth is applied in
 * index.ts and every query is scoped to the token sub (c.var.clerkUserId).
 */
import { Hono, type Context } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type { ApiResponse, FridgeStockItem, FridgeStockSource } from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { clampShelfLifeDays, estimateExpiresAt, parsePurchaseDate, parseReceiptDateText } from "../services/shelfLife";
import { expiringSoon, impactSummary, logFridgeEvent, type FridgeOutcome } from "../services/fridgeImpact";
import { scanImageForItems, VisionError, type OpenRouterVisionEnv, type ScanResult } from "../services/openrouterVision";
import { filterReceiptItems, isDiscountLine, isNonFood } from "../services/receiptFilter";

type FridgeStockEnv = DbEnv & OpenRouterVisionEnv;

export const fridgeStockRouter = new Hono<{ Bindings: FridgeStockEnv }>();

const VALID_SOURCES: FridgeStockSource[] = ["manual", "ocr", "shop-auto", "photo-scan"];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 32 KB chunks: byte-by-byte string building on a 5 MB phone photo burns Worker CPU for nothing.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const base64 = btoa(parts.join(""));
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${base64}`;
}

/** Scan one image with a prompt; throws (VisionError for model problems). Shared by the user route and /api/admin/vision-test. */
export async function scanFile(env: OpenRouterVisionEnv, file: File, prompt: string, modelOverride?: string): Promise<ScanResult> {
  const dataUrl = await fileToDataUrl(file);
  const model = modelOverride ?? (prompt === RECEIPT_PROMPT ? env.OPENROUTER_RECEIPT_MODEL : undefined);
  const result = await scanImageForItems(env, dataUrl, prompt, model);
  // Keep only a plausible receipt date (last 30 days, not in the future); the client lets the user change it.
  // The printed text wins over the model's own conversion (it once read the time 13:28 as the 13th).
  const fromText = parseReceiptDateText(result.purchaseDateText);
  const candidate = fromText ?? result.purchaseDate;
  const purchaseDate = parsePurchaseDate(candidate, new Date()) ? candidate : null;
  // Receipts only: drop discount/coupon lines and laundry/cleaning items the model let through.
  // Fridge-photo scans (a different prompt) keep every item the model returned.
  // A count above 24 is a pack weight read as a quantity ("BLUEBERRIES 510G" → 510): treat it as 1 pack.
  const isReceipt = prompt === RECEIPT_PROMPT;
  const items = (isReceipt ? filterReceiptItems(result.items) : result.items).map((i) =>
    i.quantity !== null && i.quantity > 24 ? { ...i, quantity: 1 } : i,
  );
  // Receipts that print their own item total: compare it with what we found, so the user can spot an invented or missing line.
  // Nothing is removed here; the client only shows a note. Found = kept items + non-food lines the filter dropped + non-food the model left out.
  let countCheck: ScanResult["countCheck"] = null;
  if (isReceipt && typeof result.itemsSold === "number") {
    const nonFoodRemoved = result.items.filter((i) => isNonFood(i.name) && !isDiscountLine(i.name)).length;
    countCheck = { itemsSold: result.itemsSold, found: items.length + nonFoodRemoved + (result.excludedCount ?? 0) };
  }
  return { items, purchaseDate, countCheck };
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
    const body: ApiResponse<ScanResult> = { ok: true, data: await scanFile(c.env, file, prompt) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] fridge-stock image scan error:", err instanceof Error ? err.message : String(err));
    const kind = err instanceof VisionError ? err.kind : "other";
    // Best-effort failure log for debugging (never the image itself).
    try {
      await withDb(c.env, (db) =>
        db.collection("scan_errors").insertOne({
          at: new Date().toISOString(),
          userId: c.var.clerkUserId ?? null,
          kind,
          message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          bytes: file.size,
          type: file.type || null,
          route: c.req.path,
        }),
      );
    } catch {
      // ignore: logging must not change the response
    }
    const message =
      kind === "upstream" || kind === "empty"
        ? "The scanner didn't answer. Please try again in a moment."
        : kind === "parse"
          ? "Couldn't read that photo. Try again with the receipt flat, close up and in good light."
          : "Failed to analyze image. Please try again.";
    const body: ApiResponse<never> = { ok: false, error: { code: `vision_${kind}`, message } };
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

/** Impact (fridgeImpact.ts): used vs thrown-away totals this month and all time. */
fridgeStockRouter.get("/impact", async (c) => {
  try {
    const out = await withDb(c.env, (db) => impactSummary(db, c.var.clerkUserId));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] fridge-stock impact error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "Failed to load impact" } } satisfies ApiResponse<never>, 502);
  }
});

/** Use-it-up: items expiring within ?days= (default 3, max 14), soonest first — Home card + push reminders. */
fridgeStockRouter.get("/expiring", async (c) => {
  const days = Math.min(14, Math.max(0, Number(c.req.query("days") ?? 3) || 3));
  try {
    const docs = await withDb(c.env, (db) => expiringSoon(db, c.var.clerkUserId, days));
    const out = docs.map((d) => ({ _id: String(d._id), ingredientName: String(d.ingredientName ?? ""), expiresAt: String(d.expiresAt ?? ""), quantity: Number(d.quantity) || 0, unit: String(d.unit ?? "") }));
    return c.json({ ok: true, data: out } satisfies ApiResponse<typeof out>);
  } catch (err) {
    console.error("[uiu-api] fridge-stock expiring error:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: { code: "db_error", message: "Failed to load expiring items" } } satisfies ApiResponse<never>, 502);
  }
});

fridgeStockRouter.get("/", async (c) => {
  try {
    const docs = await withDb(c.env, (db) => db.collection("fridge_stock").find({ userId: c.var.clerkUserId }).sort({ expiresAt: 1 }).toArray());
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
  // Optional (receipt / fridge scans): purchase date starts the clock, shelfLifeDays overrides the default.
  const shelfLifeDays = clampShelfLifeDays(payload?.shelfLifeDays);

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
    const purchasedAt = parsePurchaseDate(payload?.purchasedAt, now);
    const inserted = await withDb(c.env, async (db) => {
      if (canonicalId) {
        const canonicalDoc = await db.collection("canonical_ingredients").findOne({ _id: canonicalId });
        isPantry = !!canonicalDoc?.is_pantry;
      }
      const doc = {
        userId: c.var.clerkUserId,
        ingredientName: ingredientName.trim(),
        canonicalIngredientId: canonicalId,
        quantity,
        unit: unit.trim(),
        addedAt: now.toISOString(),
        purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
        expiresAt: estimateExpiresAt(isPantry, purchasedAt ?? now, shelfLifeDays),
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
        .findOneAndUpdate({ _id: new ObjectId(id), userId: c.var.clerkUserId }, { $set: update }, { returnDocument: "after" });
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
    // Impact (fridgeImpact.ts): ?outcome=used|wasted logs where the item went before it is removed. No outcome = plain delete
    // (e.g. added by mistake), not counted either way.
    const rawOutcome = c.req.query("outcome");
    const outcome: FridgeOutcome | null = rawOutcome === "used" || rawOutcome === "wasted" ? rawOutcome : null;
    const deleted = await withDb(c.env, async (db) => {
      const filter = { _id: new ObjectId(id), userId: c.var.clerkUserId };
      if (outcome) {
        const item = await db.collection("fridge_stock").findOne(filter);
        if (!item) return false;
        await logFridgeEvent(db, c.var.clerkUserId, item, outcome);
      }
      const result = await db.collection("fridge_stock").deleteOne(filter);
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
/** Typical keep-times so the model's per-item estimate stays in a sane range (Jackie 2026-10-25). */
const SHELF_LIFE_HINT = 'For each item also give "shelfLifeDays": a whole number of days it typically keeps from the day it was bought, stored the usual way in a UK home (raw meat or fish 2, mince 1, cooked meats and ham 4, salad leaves and soft berries 4, milk 7, yoghurt 10, soft cheese 7, hard cheese 28, eggs 28, bread 5, most fresh vegetables 7, carrots 21, potatoes and onions 21, apples and citrus 21, bananas 5, frozen food 180, tins and tinned meals (e.g. tinned stew, soup, beans), dried pasta, rice, flour, oil and spices 365). ';

export const RECEIPT_PROMPT =
    "Read this shopping receipt. List ONLY the food and grocery items purchased — exclude non-food " +
      "items entirely (e.g. toiletries, cleaning products, toothpaste, tissue/toilet paper, medicine, " +
      "pet supplies, batteries, stationery, kitchenware/homeware). If an item is ambiguous or you are " +
      "unsure whether it is food, leave it out rather than guessing. " +
      "Laundry and cleaning products are never food, e.g. Fairy, Persil, Ariel, Comfort, Lenor, " +
      "Finish, Domestos, Flash, Dettol — leave them out. " +
      'Skip discount, coupon and saving lines — they are not items: e.g. Costco "IRC ..." (instant ' +
      'rebate coupon) lines, "Nectar Price Saving", "Price Cut", "20% off with Lidl Plus", multibuy ' +
      "savings. List each real product only once. " +
      'UK till receipts heavily abbreviate product names — e.g. "MOISTRSNG"=Moisturising, ' +
      '"CL"=Cleanser, "LTN"=Lotion, "SHMPOO"=Shampoo, "COND"=Conditioner, "DEO"=Deodorant, ' +
      '"TOOTHPST"=Toothpaste. Also watch for known personal-care/skincare/haircare brand ' +
      "names even without a category word (e.g. Simple, Nivea, Dove, Vaseline, Sensodyne, " +
      "Colgate, Original Source, Radox, Imperial Leather) — these are never food regardless " +
      "of what follows. When a line's meaning is unclear because of abbreviation, lean " +
      "toward excluding it rather than including it — a missed grocery item is far less " +
      "harmful than a toiletry ending up in a food list. " +
      'For each remaining item give its "name" as a short, plain English product name a shopper would ' +
      "recognise — expand till abbreviations and drop store brand codes and pack sizes (e.g. " +
      '"FRAY/B MEATBL BOLOGN" = "Meatball Bolognese", "VEETEE R/GRL BSM RCE" = "Basmati Rice", ' +
      '"PORK/VEG D/LING" = "Pork & Vegetable Dumplings", "JS BRITISH S/WATRX12" = "Sparkling Water") ' +
      "and its quantity if visible (a multipack like \"X3\" or \"12PK\" counts as that number; a weight or volume like \"510G\" or \"1KG\" is NOT a quantity — use 1). " +
      SHELF_LIFE_HINT +
      "Also read the purchase date printed on the receipt. Copy it into \"purchaseDateText\" EXACTLY as printed " +
      '(e.g. "25OCT2026", "25/10/26", "25 Oct 2026") — the date only, never the time next to it ' +
      '(in "13:28:12 25OCT2026" the date is "25OCT2026"; 13 is the hour, not the day). ' +
      "Also give it as \"purchaseDate\" in YYYY-MM-DD (UK receipts print day before month, e.g. 23/10/26 = 2026-10-23). " +
      "Use null for both if there is no date or you cannot read it. " +
      'Also give "itemsSold": the total number of items the receipt itself prints (e.g. "Items Sold: 12", ' +
      '"TOTAL NUMBER OF ITEMS SOLD = 12", "8 BALANCE DUE" means 8), or null if it prints none. ' +
      'Also give "excludedCount": how many product lines you left out because they are not food (toiletries, ' +
      "cleaning, etc.) — not counting discount/coupon lines. " +
      "Only list products actually printed on the receipt; never add an item that is not there. " +
      'Respond with ONLY a JSON object, no markdown fences, no commentary: ' +
      '{"purchaseDateText": string|null, "purchaseDate": string|null, "itemsSold": number|null, "excludedCount": number|null, "items": [{"name": string, "quantity": number|null, "shelfLifeDays": number|null}]}.';

fridgeStockRouter.post("/ocr", (c) => handleImageScan(c, RECEIPT_PROMPT));

/**
 * HANDOFF_fridge-followup.md #4 — fridge photo scan. Same analysis-only,
 * confirm-before-write contract as /ocr above, just a different prompt.
 */
fridgeStockRouter.post("/scan-fridge", (c) =>
  handleImageScan(
    c,
    "List the distinct food items visible in this fridge photo. For each, give a short name and, if visible, " +
      "an approximate quantity. " +
      SHELF_LIFE_HINT +
      'Respond with ONLY a JSON array, no markdown fences, no commentary: [{"name": string, "quantity": number|null, "shelfLifeDays": number|null}].',
  ),
);
