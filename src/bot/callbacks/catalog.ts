import type { Executor } from "../../infrastructure/db/transaction.js";
import { listSellableVariants, getVariantById } from "../../modules/catalog/repository.js";
import { searchCatalog } from "../../modules/catalog/search.js";
import { createCatalogCache, type CatalogCache } from "../../modules/catalog/cache.js";
import type { SearchParser } from "../../modules/catalog/search-parser-port.js";
import type { BuyNowCallbackCodec } from "../callback-codec.js";
import {
  presentMainMenu,
  presentCategoryList,
  presentVariantList,
  presentVariantDetail,
  presentSearchResults,
  CATALOG_COPY,
  type PresentedMessage,
} from "../presenters/catalog.js";

/**
 * Catalog callback layer (T035) — the customer-facing US1 journey:
 * main menu -> category list -> category variant list -> variant detail -> search.
 *
 * Thin orchestration: reads authoritative catalog rows (repository/search, with a
 * versioned cache in front of categories) and hands them to presenters. Creates
 * NO Order and has no payment/supplier/credential capability — US1 stands alone.
 */

export interface CatalogCallbackDeps {
  db: Executor;
  parser: SearchParser;
  /** Optional injected cache (tests may share one); a default is created otherwise. */
  cache?: CatalogCache;
  /** Default page size for variant lists. */
  pageSize?: number;
  callbackCodec: BuyNowCallbackCodec;
}

export interface CatalogCallbacks {
  mainMenu(): Promise<PresentedMessage>;
  categoryList(): Promise<PresentedMessage>;
  listCategoryIds(): Promise<string[]>;
  categoryView(categoryId: string, cursor?: string): Promise<PresentedMessage>;
  variantDetail(
    variantId: string,
    telegramUserId: string | bigint | number,
  ): Promise<PresentedMessage>;
  firstSellableVariantId(): Promise<string>;
  search(rawQuery: string): Promise<PresentedMessage>;
}

export function createCatalogCallbacks(deps: CatalogCallbackDeps): CatalogCallbacks {
  const pageSize = deps.pageSize ?? 5;
  const cache = deps.cache ?? createCatalogCache();

  return {
    async mainMenu() {
      return presentMainMenu();
    },

    async categoryList() {
      const categories = await cache.getActiveCategories(deps.db);
      return presentCategoryList(categories);
    },

    async listCategoryIds() {
      const categories = await cache.getActiveCategories(deps.db);
      return categories.map((c) => c.id);
    },

    async categoryView(categoryId: string, cursor?: string) {
      // Category view lists sellable variants under that category, keyset-paginated.
      // The repository enforces the sellability invariant (hides unauthorized SKUs).
      const page = await listSellableVariants(deps.db, {
        limit: pageSize,
        cursor: cursor ?? null,
        categoryId,
      });
      return presentVariantList(page.items, { nextCursor: page.nextCursor });
    },

    async variantDetail(variantId: string, telegramUserId: string | bigint | number) {
      const variant = await getVariantById(deps.db, variantId);
      if (!variant) {
        return {
          text: CATALOG_COPY.genericError,
          buttons: [[{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }]],
        };
      }
      const callbackData = deps.callbackCodec.issue({
        telegramUserId,
        variantId: variant.id,
        expectedPriceVnd: Number(variant.price_vnd),
      });
      return presentVariantDetail(variant, callbackData);
    },

    async firstSellableVariantId() {
      const page = await listSellableVariants(deps.db, { limit: 1 });
      const first = page.items[0];
      if (!first) throw new Error("no sellable variant seeded");
      return first.id;
    },

    async search(rawQuery: string) {
      const filter = await deps.parser.parse(rawQuery);
      const page = await searchCatalog(deps.db, filter, { limit: pageSize });
      return presentSearchResults(page.items, page.nextCursor);
    },
  };
}
