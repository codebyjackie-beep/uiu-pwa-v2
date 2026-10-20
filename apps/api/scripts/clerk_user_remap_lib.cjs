// Shared bits for clerk_user_remap.cjs / clerk_user_remap_rollback.cjs / clerk_user_remap_scratch_verify.cjs.
// Clerk dev -> production instance gives every user a new `user_…` id (cc_prompt_clerk_production_cutover.md).
const fs = require("fs");
const path = require("path");

// Plain per-user collections keyed by a `userId` field (same list as migrate_m2_backfill_userid.cjs).
const USERID_COLLECTIONS = [
  "fridge_stock",
  "meal_plan_sets",
  "meal_plans",
  "user_health_profiles",
  "weight_logs",
  "meal_logs",
  "nutrition_coach_history",
  "favourite_recipes",
  "shopping_list_items",
  "recipe_browse_state",
];
// meal_plan_sequence: one doc per user, `_id` = Clerk id (mealPlanSets.ts getNextPlanNumber). `_id` is immutable -> copy + delete.
const SEQUENCE_COLLECTION = "meal_plan_sequence";
// users: `clerkUserId` field.
const USERS_COLLECTION = "users";
const ALL_COLLECTIONS = [...USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION];
// Collections with a unique index that includes userId: an existing doc under the NEW id would collide.
const UNIQUE_USER_COLLECTIONS = ["user_health_profiles", "recipe_browse_state"];

const ID_RE = /^[A-Za-z0-9_]+$/;

function loadDevVars() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve(__dirname, "../.dev.vars"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

/** All values of a repeatable `--flag value` option. */
function argValues(argv, flag) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  });
  return out;
}
function argValue(argv, flag) {
  return argValues(argv, flag)[0] ?? null;
}

module.exports = { USERID_COLLECTIONS, SEQUENCE_COLLECTION, USERS_COLLECTION, ALL_COLLECTIONS, UNIQUE_USER_COLLECTIONS, ID_RE, loadDevVars, argValues, argValue };
