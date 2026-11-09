/**
 * Request-scoped DB client — standalone assertion script (no vitest/jest in this repo). Run with:
 *   npx tsx apps/api/src/db.test.ts
 * Stubs MongoClient.connect/close (no network) and counts how many clients each pattern opens.
 */
import { MongoClient } from "mongodb";
import { withDb, withRequestDb } from "./db";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`, detail ?? "");
  } else console.log(`ok   ${name}`);
}

let connects = 0;
let closes = 0;
let failNextConnect = false;
const proto = MongoClient.prototype as unknown as { connect: () => Promise<unknown>; close: () => Promise<void> };
proto.connect = async function (this: unknown) {
  connects += 1;
  if (failNextConnect) {
    failNextConnect = false;
    throw new Error("connect failed");
  }
  return this;
};
proto.close = async function () {
  closes += 1;
};
const reset = () => {
  connects = 0;
  closes = 0;
};
const env = { MONGODB_URI: "mongodb://stub.invalid:27017", MONGODB_DB: "useitup" };
const tick = () => new Promise((r) => setTimeout(r, 5));

async function main() {
  // 1. Outside a request scope (cron/scripts): unchanged, one client per call.
  reset();
  await withDb(env, async () => 1);
  await withDb(env, async () => 2);
  check("no scope: 2 calls → 2 connects", connects === 2, connects);
  check("no scope: 2 calls → 2 closes", closes === 2, closes);

  // 2. Inside a request scope: sequential + parallel calls share one client.
  reset();
  const out = await withRequestDb(async () => {
    const a = await withDb(env, async (db) => db.databaseName);
    const [b, c] = await Promise.all([withDb(env, async () => "b"), withDb(env, async () => "c")]);
    check("scope: not closed while request is running", closes === 0, closes);
    return [a, b, c];
  });
  check("scope: results passed through", JSON.stringify(out) === JSON.stringify(["useitup", "b", "c"]), out);
  check("scope: 3 calls → 1 connect", connects === 1, connects);
  check("scope: closed once after request", closes === 1, closes);

  // 3. Errors inside fn still close the shared client exactly once.
  reset();
  let threw = false;
  try {
    await withRequestDb(async () => {
      await withDb(env, async () => 1);
      await withDb(env, async () => {
        throw new Error("boom");
      });
    });
  } catch {
    threw = true;
  }
  check("error: propagates", threw);
  check("error: 1 connect, 1 close", connects === 1 && closes === 1, { connects, closes });

  // 4. A withDb still running when the request ends keeps the client open until it finishes.
  reset();
  let lateDone: Promise<number> | undefined;
  await withRequestDb(async () => {
    await withDb(env, async () => 0);
    lateDone = withDb(env, async () => {
      await tick();
      return 7;
    });
  });
  check("late: not closed while a call is in flight", closes === 0, closes);
  const late = await lateDone!;
  check("late: in-flight call finished", late === 7, late);
  check("late: closed after in-flight call, 1 connect", closes === 1 && connects === 1, { connects, closes });

  // 5. A call that starts after the scope closed falls back to its own client.
  reset();
  let afterClose: (() => Promise<number>) | undefined;
  await withRequestDb(async () => {
    await withDb(env, async () => 0);
    afterClose = () => withDb(env, async () => 9);
  });
  const v = await afterClose!();
  check("after close: still works", v === 9, v);
  check("after close: 2 connects, 2 closes", connects === 2 && closes === 2, { connects, closes });

  // 6. A failed connect doesn't poison the rest of the request.
  reset();
  await withRequestDb(async () => {
    failNextConnect = true;
    let failed = false;
    try {
      await withDb(env, async () => 0);
    } catch {
      failed = true;
    }
    check("connect fail: first call throws", failed);
    const ok = await withDb(env, async () => 5);
    check("connect fail: retry in same request works", ok === 5, ok);
  });
  check("connect fail: 2 connects, 2 closes (failed client closed too)", connects === 2 && closes === 2, { connects, closes });

  // 7. A different URI inside the scope (e.g. backup against another cluster) gets its own client.
  reset();
  await withRequestDb(async () => {
    await withDb(env, async () => 0);
    await withDb({ ...env, MONGODB_URI: "mongodb://other.invalid:27017" }, async () => 0);
  });
  check("other uri: 2 connects, 2 closes", connects === 2 && closes === 2, { connects, closes });

  if (failures) throw new Error(`${failures} request-scoped db test(s) failed`);
  console.log("all passed");
}

await main();
