/**
 * HANDOFF_health-tab-v1.md — Milestone 1 (Part A: photo meal logging, Part C:
 * weight/profile tracking). Part B (AI Coach) and Part D (barcode) land in
 * later milestones.
 *
 * SECRET-TIER DATA — never console.log/console.error any profile/weight/meal
 * value (CLAUDE.md §4). Catch blocks below only log a generic message, never
 * the request body or the DB document.
 */
import { Hono } from "hono";
import type { Document, ObjectId as ObjectIdType } from "mongodb";
import type {
  ApiResponse,
  HealthGoal,
  MealLogEntry,
  MealLogSource,
  MealLogTotals,
  UserHealthProfile,
  WeightLogEntry,
} from "@uiu/shared";
import { withDb, type DbEnv } from "../db";
import { estimateMealNutrition, type OpenRouterVisionEnv } from "../services/openrouterVision";

type HealthEnv = DbEnv & OpenRouterVisionEnv;

export const healthRouter = new Hono<{ Bindings: HealthEnv }>();

const VALID_GOALS: HealthGoal[] = ["lose", "maintain", "gain"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// --- Profile ----------------------------------------------------------------

function toProfile(doc: Document): UserHealthProfile {
  return {
    heightCm: doc.heightCm as number,
    weightKg: doc.weightKg as number,
    goal: doc.goal as HealthGoal,
    targetWeightKg: doc.targetWeightKg as number,
    updatedAt: doc.updatedAt as string,
  };
}

healthRouter.get("/profile", async (c) => {
  try {
    const doc = await withDb(c.env, (db) => db.collection("user_health_profiles").findOne({}));
    const body: ApiResponse<UserHealthProfile | null> = { ok: true, data: doc ? toProfile(doc) : null };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] health profile get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch health profile" } };
    return c.json(body, 502);
  }
});

healthRouter.put("/profile", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const heightCm = Number(payload?.heightCm);
  const weightKg = Number(payload?.weightKg);
  const goal = payload?.goal as string | undefined;
  const targetWeightKg = Number(payload?.targetWeightKg);

  if (
    !Number.isFinite(heightCm) ||
    heightCm <= 0 ||
    !Number.isFinite(weightKg) ||
    weightKg <= 0 ||
    !goal ||
    !VALID_GOALS.includes(goal as HealthGoal) ||
    !Number.isFinite(targetWeightKg) ||
    targetWeightKg <= 0
  ) {
    const body: ApiResponse<never> = {
      ok: false,
      error: {
        code: "bad_request",
        message: `heightCm, weightKg, targetWeightKg (all > 0) and goal (one of ${VALID_GOALS.join(", ")}) are required`,
      },
    };
    return c.json(body, 400);
  }

  try {
    const updatedAt = new Date().toISOString();
    const doc = { heightCm, weightKg, goal, targetWeightKg, updatedAt };
    await withDb(c.env, (db) => db.collection("user_health_profiles").updateOne({}, { $set: doc }, { upsert: true }));
    const body: ApiResponse<UserHealthProfile> = { ok: true, data: doc as UserHealthProfile };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] health profile put error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to save health profile" } };
    return c.json(body, 502);
  }
});

// --- Weight logs --------------------------------------------------------------

function toWeightLog(doc: Document): WeightLogEntry {
  return { _id: (doc._id as ObjectIdType).toString(), weightKg: doc.weightKg as number, loggedAt: doc.loggedAt as string };
}

healthRouter.get("/weight-logs", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 12, 1), 52);
  try {
    const docs = await withDb(c.env, (db) =>
      db.collection("weight_logs").find({}).sort({ loggedAt: -1 }).limit(limit).toArray(),
    );
    const body: ApiResponse<WeightLogEntry[]> = { ok: true, data: docs.map(toWeightLog).reverse() };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] weight-logs get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch weight logs" } };
    return c.json(body, 502);
  }
});

healthRouter.post("/weight-logs", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const weightKg = Number(payload?.weightKg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "weightKg (> 0) is required" } };
    return c.json(body, 400);
  }

  try {
    const loggedAt = new Date().toISOString();
    const doc = { weightKg, loggedAt };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("weight_logs").insertOne(doc);
      // Keep the profile's "latest known weight" in sync, matching HANDOFF §3
      // (profile.weightKg = quick-read latest, weight_logs = the timeline).
      await db.collection("user_health_profiles").updateOne({}, { $set: { weightKg, updatedAt: loggedAt } });
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<WeightLogEntry> = { ok: true, data: toWeightLog(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] weight-logs post error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to log weight" } };
    return c.json(body, 502);
  }
});

// --- Meal logs ------------------------------------------------------------

function toMealLog(doc: Document): MealLogEntry {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    photoUrl: (doc.photoUrl as string | null) ?? null,
    calories: doc.calories as number,
    protein: doc.protein as number,
    carbs: doc.carbs as number,
    fat: doc.fat as number,
    description: doc.description as string,
    loggedAt: doc.loggedAt as string,
    source: doc.source as MealLogSource,
  };
}

function rangeStart(range: string | undefined): Date {
  const now = new Date();
  if (range === "week") {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 7);
    return start;
  }
  // default: "today" — UTC midnight, matches the rest of the API's ISODate-as-UTC convention.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

healthRouter.get("/meal-logs", async (c) => {
  const range = c.req.query("range");
  try {
    const since = rangeStart(range).toISOString();
    const docs = await withDb(c.env, (db) =>
      db.collection("meal_logs").find({ loggedAt: { $gte: since } }).sort({ loggedAt: -1 }).toArray(),
    );
    const entries = docs.map(toMealLog);
    const totals = entries.reduce<MealLogTotals>(
      (sum, e) => ({
        calories: sum.calories + e.calories,
        protein: sum.protein + e.protein,
        carbs: sum.carbs + e.carbs,
        fat: sum.fat + e.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    const body: ApiResponse<{ entries: MealLogEntry[]; totals: MealLogTotals }> = { ok: true, data: { entries, totals } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-logs get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch meal logs" } };
    return c.json(body, 502);
  }
});

/** Photo -> vision estimate -> insert, single round trip (no separate
 * analyze/confirm step — HANDOFF §1 describes this as one "log a meal" action,
 * unlike fridge-stock's OCR which needs a dedup-aware review step first). */
healthRouter.post("/meal-logs", async (c) => {
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
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const dataUrl = `data:${file.type || "image/jpeg"};base64,${btoa(binary)}`;

    const estimate = await estimateMealNutrition(c.env, dataUrl);
    const loggedAt = new Date().toISOString();
    const doc = {
      photoUrl: null as string | null,
      calories: estimate.calories,
      protein: estimate.protein,
      carbs: estimate.carbs,
      fat: estimate.fat,
      description: estimate.description,
      loggedAt,
      source: "photo" as MealLogSource,
    };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("meal_logs").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<MealLogEntry> = { ok: true, data: toMealLog(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] meal-logs photo error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "vision_error", message: "Failed to analyze meal photo" } };
    return c.json(body, 502);
  }
});

/** Manual entry — no photo, user types in the values directly. */
healthRouter.post("/meal-logs/manual", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const description = payload?.description as string | undefined;
  const calories = Number(payload?.calories);
  const protein = Number(payload?.protein ?? 0);
  const carbs = Number(payload?.carbs ?? 0);
  const fat = Number(payload?.fat ?? 0);

  if (typeof description !== "string" || !description.trim() || !Number.isFinite(calories) || calories < 0) {
    const body: ApiResponse<never> = {
      ok: false,
      error: { code: "bad_request", message: "description and calories (>= 0) are required" },
    };
    return c.json(body, 400);
  }

  try {
    const loggedAt = new Date().toISOString();
    const doc = {
      photoUrl: null as string | null,
      calories,
      protein: Number.isFinite(protein) ? protein : 0,
      carbs: Number.isFinite(carbs) ? carbs : 0,
      fat: Number.isFinite(fat) ? fat : 0,
      description: description.trim(),
      loggedAt,
      source: "manual" as MealLogSource,
    };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("meal_logs").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<MealLogEntry> = { ok: true, data: toMealLog(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] meal-logs manual error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to log meal" } };
    return c.json(body, 502);
  }
});
