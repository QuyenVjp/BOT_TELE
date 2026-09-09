import type { Executor } from "../../infrastructure/db/transaction.js";
import {
  listSellableVariants,
  getVariantById,
  listStorefrontProducts,
  listTestCatalogProducts,
} from "../../modules/catalog/repository.js";
import { getStoreMode, isTestCustomer } from "../../modules/commerce/store-mode.js";
import { getRealStoreStats } from "../../modules/marketing/social-proof.js";
import { presentStorefront } from "../presenters/customer.js";
import { searchCatalog } from "../../modules/catalog/search.js";
import { resolveCatalogAudience, type CatalogIdentity } from "../../modules/catalog/visibility.js";
import { createCatalogCache, type CatalogCache } from "../../modules/catalog/cache.js";
import type { SearchParser } from "../../modules/catalog/search-parser-port.js";
import type { BuyNowCallbackCodec } from "../callback-codec.js";
import { isId } from "../../shared/ids/index.js";
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
  categoryView(
    categoryId: string,
    cursor?: string,
    identity?: CatalogIdentity | undefined,
  ): Promise<PresentedMessage>;
  variantDetail(
    variantId: string,
    telegramUserId: string | bigint | number,
    identity?: CatalogIdentity | undefined,
  ): Promise<PresentedMessage>;
  firstSellableVariantId(): Promise<string>;
  search(rawQuery: string, identity?: CatalogIdentity | undefined): Promise<PresentedMessage>;
  storefront(input: {
    actorName: string;
    telegramUserId: string;
    offset?: number;
    isRootAdmin?: boolean;
  }): Promise<PresentedMessage>;
  productDetail(
    productId: string,
    telegramUserId: string | bigint | number,
    identity?: CatalogIdentity | undefined,
  ): Promise<PresentedMessage>;
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

    async categoryView(
      categoryId: string,
      cursor?: string,
      identity?: CatalogIdentity | undefined,
    ) {
      // Category view lists sellable variants under that category, keyset-paginated.
      // The repository enforces the sellability invariant (hides unauthorized SKUs).
      const audience = await resolveCatalogAudience(deps.db, identity);
      const page = await listSellableVariants(deps.db, {
        limit: pageSize,
        cursor: cursor ?? null,
        categoryId,
        audience,
      });
      return presentVariantList(page.items, { nextCursor: page.nextCursor });
    },

    async variantDetail(
      variantId: string,
      telegramUserId: string | bigint | number,
      identity?: CatalogIdentity | undefined,
    ) {
      const audience = await resolveCatalogAudience(deps.db, {
        telegramUserId: String(telegramUserId),
        isRootAdmin: identity?.isRootAdmin === true,
      });
      const variant = await getVariantById(deps.db, variantId, audience);
      if (!variant) {
        return {
          text: CATALOG_COPY.genericError,
          buttons: [[{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }]],
        };
      }
      let buyNowCallbackData: string | undefined;
      const expectedPriceVnd = Number(variant.price_vnd);
      if (isId(variant.id) && Number.isSafeInteger(expectedPriceVnd) && expectedPriceVnd > 0) {
        try {
          buyNowCallbackData = deps.callbackCodec.issue({
            telegramUserId,
            variantId: variant.id,
            expectedPriceVnd,
          });
        } catch {
          buyNowCallbackData = undefined;
        }
      }
      return buyNowCallbackData
        ? presentVariantDetail(variant, buyNowCallbackData)
        : presentVariantDetail(variant);
    },

    async firstSellableVariantId() {
      const page = await listSellableVariants(deps.db, { limit: 1 });
      const first = page.items[0];
      if (!first) throw new Error("no sellable variant seeded");
      return first.id;
    },

    async search(rawQuery: string, identity?: CatalogIdentity | undefined) {
      const filter = await deps.parser.parse(rawQuery);
      const audience = await resolveCatalogAudience(deps.db, identity);
      const page = await searchCatalog(deps.db, filter, { limit: pageSize, audience });
      return presentSearchResults(page.items, page.nextCursor);
    },

    async storefront(input) {
      const offset = input.offset ?? 0;
      const { items, total } = await listStorefrontProducts(deps.db, 6, offset);
      const stats = await getRealStoreStats(deps.db);
      const mode = await getStoreMode(deps.db);
      const maySeeTest =
        mode === "TEST" &&
        (input.isRootAdmin === true || (await isTestCustomer(deps.db, input.telegramUserId)));
      const testProducts = maySeeTest ? (await listTestCatalogProducts(deps.db, 6, 0)).items : [];
      return presentStorefront({
        actorName: input.actorName,
        isRootAdmin: input.isRootAdmin,
        products: items,
        totalProducts: total,
        offset,
        limit: 6,
        stats,
        testProducts,
      });
    },

    async productDetail(productId, telegramUserId, identity?: CatalogIdentity | undefined) {
      const audience = await resolveCatalogAudience(deps.db, {
        telegramUserId: String(telegramUserId),
        isRootAdmin: identity?.isRootAdmin === true,
      });
      const page = await listSellableVariants(deps.db, { limit: 1, productId, audience });
      const first = page.items[0];
      if (!first) {
        return {
          text: "Sản phẩm không khả dụng hoặc chưa mở bán.",
          buttons: [[{ text: "🛒 Về trang chủ", callbackData: "shop:home" }]],
        };
      }
      return this.variantDetail(first.id, telegramUserId, identity);
    },
  };
}
