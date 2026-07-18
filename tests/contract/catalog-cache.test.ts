import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/infrastructure/db/transaction.js";
import { createCatalogCache } from "../../src/modules/catalog/cache.js";
import type { CatalogCategoryRow } from "../../src/modules/catalog/repository.js";

const EXECUTOR_FIXTURE = {} as Executor;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("catalog cache single-flight", () => {
  it("collapses concurrent cold misses into one authoritative load", async () => {
    const gate = deferred<CatalogCategoryRow[]>();
    let loads = 0;
    const cache = createCatalogCache({
      loadCategories() {
        loads += 1;
        return gate.promise;
      },
    });

    const reads = Array.from({ length: 20 }, () => cache.getActiveCategories(EXECUTOR_FIXTURE));
    await Promise.resolve();
    expect(loads).toBe(1);
    gate.resolve([]);
    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 20 }, () => []));
  });

  it("does not let an invalidated in-flight result repopulate the new cache version", async () => {
    const first = deferred<CatalogCategoryRow[]>();
    const second = deferred<CatalogCategoryRow[]>();
    let loads = 0;
    const cache = createCatalogCache({
      loadCategories() {
        loads += 1;
        return loads === 1 ? first.promise : second.promise;
      },
    });
    const staleRead = cache.getActiveCategories(EXECUTOR_FIXTURE);
    cache.invalidate();
    const freshRead = cache.getActiveCategories(EXECUTOR_FIXTURE);
    expect(loads).toBe(2);
    first.resolve([{ id: "stale", name_vi: "Stale", slug: "stale", sort_order: 1 }]);
    second.resolve([{ id: "fresh", name_vi: "Fresh", slug: "fresh", sort_order: 1 }]);
    await staleRead;
    await expect(freshRead).resolves.toMatchObject([{ id: "fresh" }]);
    await expect(cache.getActiveCategories(EXECUTOR_FIXTURE)).resolves.toMatchObject([
      { id: "fresh" },
    ]);
  });
});
