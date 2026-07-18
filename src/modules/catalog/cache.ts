import type { Executor } from "../../infrastructure/db/transaction.js";
import { listActiveCategories, type CatalogCategoryRow } from "./repository.js";

/**
 * Catalog/menu versioned cache with database fallback (T036).
 *
 * Category and menu reads are hot and rarely change, so we cache them in-process
 * with a short TTL. The cache is advisory: on miss or expiry it reads the
 * authoritative database, and any read path can bypass it. A `version` bump
 * (e.g. after an admin catalog edit) invalidates immediately. This is ephemeral
 * acceleration only — never a source of truth (Constitution: PostgreSQL is
 * authoritative).
 */

export interface CatalogCache {
  getActiveCategories(exec: Executor): Promise<CatalogCategoryRow[]>;
  invalidate(): void;
}

interface Entry<T> {
  value: T;
  expiresAtMs: number;
  version: number;
}

export interface CacheOptions {
  ttlMs?: number;
  now?: () => number;
  loadCategories?: (exec: Executor) => Promise<CatalogCategoryRow[]>;
}

export function createCatalogCache(options: CacheOptions = {}): CatalogCache {
  const ttlMs = options.ttlMs ?? 5_000;
  const clock = options.now ?? Date.now;
  const loadCategories = options.loadCategories ?? listActiveCategories;
  let version = 0;
  let categories: Entry<CatalogCategoryRow[]> | undefined;
  let inFlight: { version: number; promise: Promise<CatalogCategoryRow[]> } | undefined;

  return {
    async getActiveCategories(exec: Executor): Promise<CatalogCategoryRow[]> {
      const nowMs = clock();
      if (categories && categories.version === version && categories.expiresAtMs > nowMs) {
        return categories.value;
      }
      if (inFlight?.version === version) return inFlight.promise;

      // One authoritative read per cache version. Invalidating while the read
      // is in flight starts a new load and prevents the stale result from
      // repopulating the newer version.
      const loadVersion = version;
      const promise = loadCategories(exec)
        .then((fresh) => {
          if (version === loadVersion) {
            categories = { value: fresh, expiresAtMs: clock() + ttlMs, version: loadVersion };
          }
          return fresh;
        })
        .finally(() => {
          if (inFlight?.promise === promise) inFlight = undefined;
        });
      inFlight = { version: loadVersion, promise };
      return promise;
    },

    invalidate(): void {
      version += 1;
      categories = undefined;
    },
  };
}
