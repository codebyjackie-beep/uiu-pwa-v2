import type { Db } from "mongodb";

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
 * Opens a fresh client per call and closes it before returning. A client (and its TCP
 * socket) is bound to the I/O context of the request that created it — caching one across
 * requests leaves later requests hanging on a socket that's already dead. Revisit with a
 * Durable Object-backed pool if per-request connect latency becomes a problem.
 */
export async function withDb<T>(env: DbEnv, fn: (db: Db) => Promise<T>): Promise<T> {
  const { MongoClient } = await getMongoModule();
  const client = new MongoClient(env.MONGODB_URI);
  try {
    await client.connect();
    return await fn(client.db(env.MONGODB_DB));
  } finally {
    await client.close();
  }
}
