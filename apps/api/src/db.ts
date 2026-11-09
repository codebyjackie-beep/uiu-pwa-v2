import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, MongoClient } from "mongodb";

export interface DbEnv {
  MONGODB_URI: string;
  MONGODB_DB: string;
}

/**
 * `mongodb`'s bson dependency touches crypto at module-evaluation time, which Workers
 * disallows in global scope. Loading it via dynamic import() defers that evaluation until
 * this is first called from inside a request handler, where I/O/crypto is allowed.
 */
let mongoModulePromise: Promise<typeof import("mongodb")> | undefined;

export function getMongoModule(): Promise<typeof import("mongodb")> {
  if (!mongoModulePromise) {
    mongoModulePromise = import("mongodb");
  }
  return mongoModulePromise;
}

/**
 * Request-scoped client (perf, 2026-11-09). A client (and its TCP socket) is bound to the
 * I/O context of the request that created it, so it must never be cached across requests —
 * but one request often calls withDb() several times (e.g. /api/users/sync = findOne then
 * insert; requireUser + handler), and each call used to pay a fresh TCP+TLS+auth handshake.
 * `withRequestDb()` (Hono middleware in index.ts) opens a scope per incoming request; every
 * withDb() inside it shares one lazily-connected client, closed when the request finishes
 * and no withDb() call is still running. Outside a scope (cron `scheduled()`, scripts),
 * withDb() keeps the old open-per-call behaviour.
 */
interface RequestDbScope {
  uri?: string;
  clientPromise?: Promise<MongoClient>;
  active: number;
  ended: boolean;
  closed: boolean;
}

const requestScope = new AsyncLocalStorage<RequestDbScope>();

async function closeScope(scope: RequestDbScope): Promise<void> {
  if (scope.closed || !scope.clientPromise) return;
  scope.closed = true;
  try {
    const client = await scope.clientPromise;
    await client.close();
  } catch {
    // connect() failed or already closed — nothing to clean up.
  }
}

/** Runs `fn` with a per-request DB scope; the shared client is closed after `fn` settles. */
export async function withRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  const scope: RequestDbScope = { active: 0, ended: false, closed: false };
  try {
    return await requestScope.run(scope, fn);
  } finally {
    scope.ended = true;
    if (scope.active === 0) await closeScope(scope);
  }
}

async function openClient(uri: string): Promise<MongoClient> {
  const { MongoClient } = await getMongoModule();
  const client = new MongoClient(uri);
  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

export async function withDb<T>(env: DbEnv, fn: (db: Db) => Promise<T>): Promise<T> {
  const scope = requestScope.getStore();
  // No scope, scope already closed (late call after the response), or a different URI
  // (e.g. a backup job pointing at another cluster): open-per-call as before.
  if (!scope || scope.closed || (scope.uri !== undefined && scope.uri !== env.MONGODB_URI)) {
    const client = await openClient(env.MONGODB_URI);
    try {
      return await fn(client.db(env.MONGODB_DB));
    } finally {
      await client.close();
    }
  }

  scope.active += 1;
  try {
    if (!scope.clientPromise) {
      scope.uri = env.MONGODB_URI;
      scope.clientPromise = openClient(env.MONGODB_URI);
      // A failed connect must not poison later calls in the same request.
      scope.clientPromise.catch(() => {
        scope.clientPromise = undefined;
        scope.uri = undefined;
      });
    }
    const client = await scope.clientPromise;
    return await fn(client.db(env.MONGODB_DB));
  } finally {
    scope.active -= 1;
    if (scope.ended && scope.active === 0) await closeScope(scope);
  }
}
