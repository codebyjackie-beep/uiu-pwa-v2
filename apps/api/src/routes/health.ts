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
  NutritionCoachMessage,
  UserHealthProfile,
  WeightLogEntry,
} from "@uiu/shared";
import { withDb, getMongoModule, type DbEnv } from "../db";
import { estimateMealNutrition, type OpenRouterVisionEnv } from "../services/openrouterVision";
import { chatWithCoach, type CoachChatMessage, type NutritionCoachEnv } from "../services/nutritionCoach";

type HealthEnv = DbEnv & OpenRouterVisionEnv & NutritionCoachEnv;

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

healthRouter.patch("/weight-logs/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid weight_logs id" } };
    return c.json(body, 400);
  }

  const payload = await c.req.json().catch(() => null);
  const weightKg = Number(payload?.weightKg);
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "weightKg (> 0) is required" } };
    return c.json(body, 400);
  }

  try {
    const updated = await withDb(c.env, async (db) => {
      const result = await db
        .collection("weight_logs")
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { weightKg } }, { returnDocument: "after" });
      return result;
    });
    if (!updated) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "weight_logs entry not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<WeightLogEntry> = { ok: true, data: toWeightLog(updated) };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] weight-logs patch error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to update weight log" } };
    return c.json(body, 502);
  }
});

healthRouter.delete("/weight-logs/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid weight_logs id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("weight_logs").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "weight_logs entry not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] weight-logs delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete weight log" } };
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

healthRouter.delete("/meal-logs/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid meal_logs id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("meal_logs").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "meal_logs entry not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] meal-logs delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete meal log" } };
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

/** Barcode lookup — client already resolved the barcode -> Open Food Facts
 * product client-side (public no-key API, HANDOFF §4); this just persists the
 * resulting macros for a chosen consumed amount, mirroring the manual-entry
 * insert shape but tagged source:"barcode". */
healthRouter.post("/meal-logs/barcode", async (c) => {
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
      source: "barcode" as MealLogSource,
    };
    const inserted = await withDb(c.env, async (db) => {
      const result = await db.collection("meal_logs").insertOne(doc);
      return { ...doc, _id: result.insertedId };
    });
    const body: ApiResponse<MealLogEntry> = { ok: true, data: toMealLog(inserted) };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] meal-logs barcode error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to log meal" } };
    return c.json(body, 502);
  }
});

// --- AI Nutrition Coach (HANDOFF §2) --------------------------------------

const COACH_HISTORY_LIMIT = 20;

const COACH_SYSTEM_PROMPT =
  "You are a supportive, practical nutrition coach inside the UseItUp app. Keep replies concise " +
  "(2-4 short sentences unless the user explicitly asks for more detail). You are not a doctor or " +
  "registered dietitian — if you give specific numeric targets or anything that could be read as " +
  "medical advice, briefly note it isn't medical advice. Use the context below (profile, recent weight " +
  "trend, today's intake) to personalize answers, and remember earlier turns in this conversation " +
  "(e.g. stated dietary restrictions) without asking the user to repeat themselves.";

function toCoachMessage(doc: Document): NutritionCoachMessage {
  return {
    _id: (doc._id as ObjectIdType).toString(),
    role: doc.role as "user" | "assistant",
    content: doc.content as string,
    createdAt: doc.createdAt as string,
  };
}

function buildCoachContext(profile: UserHealthProfile | null, recentWeights: WeightLogEntry[], todayTotals: MealLogTotals): string {
  const lines: string[] = [];
  if (profile) {
    const bmi = profile.weightKg / (profile.heightCm / 100) ** 2;
    lines.push(
      `User profile — height ${profile.heightCm}cm, weight ${profile.weightKg}kg, BMI ${bmi.toFixed(1)}, ` +
        `goal: ${profile.goal}, target weight ${profile.targetWeightKg}kg.`,
    );
  } else {
    lines.push("User has not filled in a health profile yet.");
  }
  if (recentWeights.length >= 2) {
    const first = recentWeights[0]!;
    const last = recentWeights[recentWeights.length - 1]!;
    lines.push(`Recent weight logs: ${first.weightKg}kg -> ${last.weightKg}kg over the last ${recentWeights.length} entries.`);
  }
  lines.push(
    `Today so far: ${Math.round(todayTotals.calories)} kcal, ${Math.round(todayTotals.protein)}g protein, ` +
      `${Math.round(todayTotals.carbs)}g carbs, ${Math.round(todayTotals.fat)}g fat.`,
  );
  return `Context for personalizing your answer (do not just read these numbers back verbatim): ${lines.join(" ")}`;
}

healthRouter.get("/coach", async (c) => {
  try {
    const docs = await withDb(c.env, (db) =>
      db.collection("nutrition_coach_history").find({}).sort({ createdAt: -1 }).limit(COACH_HISTORY_LIMIT).toArray(),
    );
    const body: ApiResponse<NutritionCoachMessage[]> = { ok: true, data: docs.map(toCoachMessage).reverse() };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] coach history get error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to fetch coach history" } };
    return c.json(body, 502);
  }
});

healthRouter.post("/coach", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!message || message.length > 2000) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "message (1-2000 chars) is required" } };
    return c.json(body, 400);
  }

  try {
    const { historyDocs, profileDoc, weightDocs, todayTotals } = await withDb(c.env, async (db) => {
      const historyDocs = await db
        .collection("nutrition_coach_history")
        .find({})
        .sort({ createdAt: -1 })
        .limit(COACH_HISTORY_LIMIT)
        .toArray();
      const profileDoc = await db.collection("user_health_profiles").findOne({});
      const weightDocs = await db.collection("weight_logs").find({}).sort({ loggedAt: -1 }).limit(5).toArray();
      const todayStart = rangeStart("today").toISOString();
      const mealDocs = await db.collection("meal_logs").find({ loggedAt: { $gte: todayStart } }).toArray();
      const todayTotals = mealDocs.reduce<MealLogTotals>(
        (sum, e) => ({
          calories: sum.calories + (e.calories as number),
          protein: sum.protein + (e.protein as number),
          carbs: sum.carbs + (e.carbs as number),
          fat: sum.fat + (e.fat as number),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      );
      return { historyDocs, profileDoc, weightDocs, todayTotals };
    });

    const history = historyDocs.map(toCoachMessage).reverse();
    const context = buildCoachContext(
      profileDoc ? toProfile(profileDoc) : null,
      weightDocs.map(toWeightLog).reverse(),
      todayTotals,
    );

    const messages: CoachChatMessage[] = [
      { role: "system", content: `${COACH_SYSTEM_PROMPT}\n\n${context}` },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const reply = await chatWithCoach(c.env, messages);

    const inserted = await withDb(c.env, async (db) => {
      const userDoc = { role: "user" as const, content: message, createdAt: new Date().toISOString() };
      const userResult = await db.collection("nutrition_coach_history").insertOne(userDoc);
      const assistantDoc = { role: "assistant" as const, content: reply, createdAt: new Date().toISOString() };
      const assistantResult = await db.collection("nutrition_coach_history").insertOne(assistantDoc);
      return { user: { ...userDoc, _id: userResult.insertedId }, assistant: { ...assistantDoc, _id: assistantResult.insertedId } };
    });

    const body: ApiResponse<{ userMessage: NutritionCoachMessage; assistantMessage: NutritionCoachMessage }> = {
      ok: true,
      data: { userMessage: toCoachMessage(inserted.user), assistantMessage: toCoachMessage(inserted.assistant) },
    };
    return c.json(body, 201);
  } catch (err) {
    console.error("[uiu-api] coach post error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "coach_error", message: "Failed to get a coach reply" } };
    return c.json(body, 502);
  }
});

healthRouter.delete("/coach/:id", async (c) => {
  const { ObjectId } = await getMongoModule();
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) {
    const body: ApiResponse<never> = { ok: false, error: { code: "bad_request", message: "Invalid nutrition_coach_history id" } };
    return c.json(body, 400);
  }

  try {
    const deleted = await withDb(c.env, async (db) => {
      const result = await db.collection("nutrition_coach_history").deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    });
    if (!deleted) {
      const body: ApiResponse<never> = { ok: false, error: { code: "not_found", message: "nutrition_coach_history entry not found" } };
      return c.json(body, 404);
    }
    const body: ApiResponse<{ deleted: true }> = { ok: true, data: { deleted: true } };
    return c.json(body);
  } catch (err) {
    console.error("[uiu-api] coach delete error:", err instanceof Error ? err.message : String(err));
    const body: ApiResponse<never> = { ok: false, error: { code: "db_error", message: "Failed to delete coach message" } };
    return c.json(body, 502);
  }
});
