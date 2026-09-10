import type { Executor } from "../../infrastructure/db/transaction.js";
import {
  listSellableVariants,
  getVariantById,
  listPublicRootCategories,
  listPublicCategoryPage,
  listFeaturedProducts,
  getProductDetail,
} from "../../modules/catalog/repository.js";
import { getShopProfile } from "../../modules/catalog/shop-profile.js";
import { getRealStoreStats } from "../../modules/marketing/social-proof.js";
import { verifyProductLinkToken } from "../../modules/catalog/product-link-token.js";
import { presentStorefront } from "../presenters/customer.js";
import { searchCatalog } from "../../modules/catalog/search.js";
import { resolveCatalogAudience, type CatalogIdentity } from "../../modules/catalog/visibility.js";
import type { CatalogCache } from "../../modules/catalog/cache.js";
import type { SearchParser } from "../../modules/catalog/search-parser-port.js";
import type { BuyNowCallbackCodec, CallbackTokenCodec } from "../callback-codec.js";
import { isId } from "../../shared/ids/index.js";
import {
  presentCategoryList,
  presentVariantDetail,
  presentSearchResults,
  presentCategoryPage,
  presentProductDetail,
  CATALOG_COPY,
  type PresentedMessage,
} from "../presenters/catalog.js";

/**
 * Catalog callback layer (T035) — the customer-facing US1 journey:
 * storefront -> category (brand) -> product detail with duration Buy Now.
 *
 * Thin orchestration: reads authoritative catalog rows (repository/search)
 * and hands them to presenters. Creates
 * NO Order and has no payment/supplier/credential capability — US1 stands alone.
 */

export interface CatalogCallbackDeps {
  db: Executor;
  parser: SearchParser;
  /** Optional injected cache; listing no longer falls back to it. */
  cache?: CatalogCache;
  /** Default page size for variant lists. */
  pageSize?: number;
  callbackCodec: BuyNowCallbackCodec;
  /**
   * Unified token codec. When present the Buy Now button issues a CHECKOUT_PREVIEW token so
   * the customer confirms the order before any financial intent exists (goal §32); absent, it
   * falls back to the legacy sealed Buy Now token.
   */
  tokenCodec?: CallbackTokenCodec;
  productLinkSecret?: string;
  /** Goal §28: opens the one-shot permission the search prompt needs before it accepts text. */
  searchPrompt?: {
    open(input: { chatId: string; correlationId: string }): Promise<void>;
  };
  /** Warranty screens, passed through to the dispatcher. */
  warranty?: CatalogCallbacks["warranty"];
}

export interface CatalogCallbacks {
  mainMenu(): Promise<PresentedMessage>;
  categoryList(identity?: CatalogIdentity | undefined): Promise<PresentedMessage>;
  listCategoryIds(identity?: CatalogIdentity | undefined): Promise<string[]>;
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
  /** Goal §28: the search prompt's permission, passed through to the dispatcher. */
  searchPrompt?: {
    open(input: { chatId: string; correlationId: string }): Promise<void>;
  };
  /** Goal §6–§9: policy, defect report and claim view. */
  warranty?: {
    policy(input: {
      telegramUserId: string;
      variantId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    issueTypes(input: {
      telegramUserId: string;
      variantId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    preview(input: {
      telegramUserId: string;
      variantId: string;
      issueType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    report(input: {
      telegramUserId: string;
      variantId: string;
      issueType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    claim(input: {
      telegramUserId: string;
      claimRef: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
  };
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
  openStartPayload(
    payload: string,
    input: {
      actorName: string;
      telegramUserId: string;
      isRootAdmin?: boolean;
    },
  ): Promise<PresentedMessage>;
}

function parsePage(cursor?: string): number {
  if (!cursor) return 0;
  if (!/^\d{1,6}$/.test(cursor)) return 0;
  return Number(cursor);
}

export function createCatalogCallbacks(deps: CatalogCallbackDeps): CatalogCallbacks {
  const pageSize = deps.pageSize ?? 5;

  const issueBuyNow = (
    telegramUserId: string | bigint | number,
    variant: { id: string; price_vnd: string; is_ready: boolean },
  ): string | undefined => {
    const expectedPriceVnd = Number(variant.price_vnd);
    if (
      !variant.is_ready ||
      !isId(variant.id) ||
      !Number.isSafeInteger(expectedPriceVnd) ||
      expectedPriceVnd <= 0
    ) {
      return undefined;
    }
    try {
      if (deps.tokenCodec) {
        return deps.tokenCodec.issue({
          action: "CHECKOUT_PREVIEW",
          telegramUserId,
          resourceId: variant.id,
        });
      }
      return deps.callbackCodec.issue({
        telegramUserId,
        variantId: variant.id,
        expectedPriceVnd,
      });
    } catch {
      return undefined;
    }
  };

  const callbacks: CatalogCallbacks = {
    ...(deps.searchPrompt ? { searchPrompt: deps.searchPrompt } : {}),
    ...(deps.warranty ? { warranty: deps.warranty } : {}),
    async mainMenu() {
      return callbacks.storefront({
        actorName: "bạn",
        telegramUserId: "0",
        offset: 0,
        isRootAdmin: false,
      });
    },

    async categoryList(identity?: CatalogIdentity | undefined) {
      const audience = await resolveCatalogAudience(deps.db, identity);
      const categories = await listPublicRootCategories(deps.db, audience);
      return presentCategoryList(categories);
    },

    async listCategoryIds(identity?: CatalogIdentity | undefined) {
      const audience = await resolveCatalogAudience(deps.db, identity);
      const categories = await listPublicRootCategories(deps.db, audience);
      return categories.map((c) => c.id);
    },

    async categoryView(
      categoryId: string,
      cursor?: string,
      identity?: CatalogIdentity | undefined,
    ) {
      const audience = await resolveCatalogAudience(deps.db, identity);
      const page = await listPublicCategoryPage(
        deps.db,
        categoryId,
        audience,
        parsePage(cursor),
        8,
      );
      if (!page) {
        return {
          text: CATALOG_COPY.emptyCategory,
          buttons: [[{ text: "🛒 Về trang chủ", callbackData: "shop:home" }]],
        };
      }
      return presentCategoryPage(page);
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
      const buyNowCallbackData = issueBuyNow(telegramUserId, variant);
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
      const audience = await resolveCatalogAudience(deps.db, {
        telegramUserId: input.telegramUserId,
        isRootAdmin: input.isRootAdmin === true,
      });
      const [profile, categories, featured, stats] = await Promise.all([
        getShopProfile(deps.db),
        listPublicRootCategories(deps.db, audience),
        listFeaturedProducts(deps.db, audience, 3),
        getRealStoreStats(deps.db),
      ]);
      return presentStorefront({
        actorName: input.actorName,
        isRootAdmin: input.isRootAdmin,
        shopName: profile.shopName,
        shopTagline: profile.tagline,
        communityUrl: profile.communityUrl,
        categories: categories.map((category) => ({
          id: category.id,
          name: category.display_name_vi || category.name_vi,
          icon: category.icon,
        })),
        featuredProducts: featured,
        stats: { completedOrders: stats.completedOrders },
      });
    },

    async productDetail(productId, telegramUserId, identity?: CatalogIdentity | undefined) {
      const audience = await resolveCatalogAudience(deps.db, {
        telegramUserId: String(telegramUserId),
        isRootAdmin: identity?.isRootAdmin === true,
      });
      const detail = await getProductDetail(deps.db, productId, audience);
      if (!detail) {
        return {
          text: "Sản phẩm không khả dụng hoặc chưa mở bán.",
          buttons: [[{ text: "🛒 Về trang chủ", callbackData: "shop:home" }]],
        };
      }
      const buyNowByVariantId: Record<string, string | undefined> = {};
      for (const variant of detail.variants) {
        buyNowByVariantId[variant.id] = issueBuyNow(telegramUserId, variant);
      }
      return presentProductDetail(detail, buyNowByVariantId);
    },

    async openStartPayload(payload, input) {
      const home = () =>
        callbacks.storefront({
          actorName: input.actorName,
          telegramUserId: input.telegramUserId,
          offset: 0,
          ...(input.isRootAdmin === true ? { isRootAdmin: true } : {}),
        });
      if (!deps.productLinkSecret || !payload.startsWith("product_")) return home();
      const productId = verifyProductLinkToken(payload, { secret: deps.productLinkSecret });
      if (!productId) return home();
      return callbacks.productDetail(productId, input.telegramUserId, {
        telegramUserId: input.telegramUserId,
        isRootAdmin: input.isRootAdmin === true,
      });
    },
  };

  return callbacks;
}
