/**
 * Workers provides node:async_hooks AsyncLocalStorage under nodejs_compat (wrangler.toml), but this
 * package has no @types/node. Minimal surface used by services/premium.ts.
 */
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
