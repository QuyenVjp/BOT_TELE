import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { CatalogCategoryRow, CatalogVariantRow } from "../../modules/catalog/repository.js";
import type { StockOutcomeCode } from "../../modules/commerce/buy-now.js";
import { isSupportedCatalogRoute } from "../../modules/catalog/domain.js";

/**
 * Authoritative product-card presenters + Vietnamese state/error copy (FR-001–FR-003,
 * telegram-ux.md Presentation rules).
 *
 * Every card is built ONLY from catalog repository rows — the presenter never invents
 * a price, duration, warranty, or availability claim. Free text from search is never
 * rendered as a product fact (FR-005).
 */

export const CATALOG_COPY = {
  mainMenuTitle: "🛒 SHOP DIGITAL",
  browse: "🛍 Danh sách sản phẩm",
  search: "🔍 Tìm sản phẩm",
  orders: "📦 Đơn hàng",
  support: "💬 Hỗ trợ",
  back: "Quay lại",
  mainMenu: "Menu chính",
  buyNow: "Mua ngay",
  emptyCatalog: "Hiện chưa có sản phẩm nào đang bán.",
  emptySearch: "Không tìm thấy sản phẩm phù hợp. Thử từ khóa khác nhé.",
  rateLimited: "Bạn thao tác hơi nhanh. Vui lòng thử lại sau giây lát.",
  genericError: "Có lỗi xảy ra. Vui lòng thử lại hoặc liên hệ hỗ trợ.",
  viewAlternatives: "🔎 Xem sản phẩm khác",
  restockSubscribe: "🔔 Báo khi có hàng",
} as const;

export interface InlineButton {
  text: string;
  callbackData: string;
  webAppUrl?: string;
}
export interface ReplyKeyboardButton {
  text: string;
  requestContact?: boolean;
}

export interface ReplyKeyboard {
  buttons: ReplyKeyboardButton[][];
  persistent?: boolean;
  resizeKeyboard?: boolean;
}

export interface PresentedMessage {
  text: string;
  buttons: InlineButton[][];
  replyKeyboard?: ReplyKeyboard;
  /** Optional binary photo media, currently used only by payment QR screens. */
  photo?: Buffer;
  /** Optional document media, used for paid ZIP delivery and admin CSV templates. */
  document?:
    | string
    | {
        kind: "file_path" | "file_id";
        value: string;
        filename?: string;
      }
    | {
        kind: "buffer";
        value: Buffer;
        filename?: string;
      };
}

const STOCK_OUTCOME_COPY: Readonly<Record<StockOutcomeCode, string>> = Object.freeze({
  NO_STOCK: "Sản phẩm hiện đã hết hàng. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  RESERVATION_LOST:
    "Sản phẩm cuối vừa được khách khác đặt trước. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  CONTENTION_TIMEOUT:
    "Đang có nhiều người đặt sản phẩm này. Vui lòng thử lại sau vài giây. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
});

/** Main retail menu (FR-001). No wallet/top-up/reseller/admin controls. */
export function presentMainMenu(): PresentedMessage {
  return {
    text: CATALOG_COPY.mainMenuTitle,
    buttons: [
      [{ text: CATALOG_COPY.browse, callbackData: "cat:list" }],
      [
        { text: CATALOG_COPY.search, callbackData: "cat:search" },
        { text: CATALOG_COPY.orders, callbackData: "ord:list" },
      ],
      [{ text: CATALOG_COPY.support, callbackData: "sup:open" }],
    ],
  };
}

/** Active category list. */
export function presentCategoryList(categories: CatalogCategoryRow[]): PresentedMessage {
  if (categories.length === 0) {
    return {
      text: CATALOG_COPY.emptyCatalog,
      buttons: [[{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }]],
    };
  }
  const buttons: InlineButton[][] = categories.map((c) => [
    { text: c.name_vi, callbackData: `cat:view:${c.id}` },
  ]);
  buttons.push([{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }]);
  return { text: "Chọn danh mục:", buttons };
}

/** Paginated sellable variant cards. */
export function presentVariantList(
  variants: CatalogVariantRow[],
  options: { nextCursor: string | null; title?: string },
): PresentedMessage {
  if (variants.length === 0) {
    return {
      text: options.title ?? CATALOG_COPY.emptyCatalog,
      buttons: [
        [{ text: CATALOG_COPY.back, callbackData: "cat:list" }],
        [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
      ],
    };
  }

  const lines = variants.map((v, i) => {
    const price = formatVnd(makeVnd(BigInt(v.price_vnd)));
    return `${i + 1}. ${v.product_name_vi} — ${v.name_vi}\n   ${price} · ${v.duration_code ?? "—"} · ${deliveryLabel(v.delivery_type)}`;
  });

  const buttons: InlineButton[][] = variants.map((v) => [
    {
      text: `${v.product_name_vi} · ${formatVnd(makeVnd(BigInt(v.price_vnd)))}`,
      callbackData: `var:view:${v.id}`,
    },
  ]);
  if (options.nextCursor) {
    buttons.push([{ text: "Trang sau ›", callbackData: `var:page:${options.nextCursor}` }]);
  }
  buttons.push(
    [{ text: CATALOG_COPY.back, callbackData: "cat:list" }],
    [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
  );

  return {
    text: (options.title ?? "Sản phẩm đang bán") + "\n\n" + lines.join("\n\n"),
    buttons,
  };
}

/** Product detail with all FR-003 authoritative fields before Buy Now. */
export function presentVariantDetail(
  variant: CatalogVariantRow,
  buyNowCallbackData?: string,
  restockSubscribeCallbackData = `rst:sub:${variant.id}`,
): PresentedMessage {
  const price = formatVnd(makeVnd(BigInt(variant.price_vnd)));
  const text = [
    `📦 ${variant.product_name_vi}`,
    `Gói: ${variant.name_vi}`,
    `Giá: ${price}`,
    `Thời hạn: ${variant.duration_code ?? "—"}`,
    `Giao hàng: ${deliveryLabel(variant.delivery_type)}`,
    `Bảo hành: ${variant.warranty_days} ngày`,
    `Tồn kho: ${stockLabel(variant)}`,
    "",
    variant.is_ready
      ? "Nhấn Mua ngay để tạo đơn (1 gói = 1 đơn)."
      : "Sản phẩm đang chờ bổ sung nguồn hàng.",
  ].join("\n");

  const buttons: InlineButton[][] = [];
  if (
    variant.is_ready &&
    isSupportedCatalogRoute({
      stockPolicy: variant.stock_policy,
      fulfillmentType: variant.fulfillment_type,
    }) &&
    buyNowCallbackData !== undefined
  ) {
    buttons.push([{ text: CATALOG_COPY.buyNow, callbackData: buyNowCallbackData }]);
  }
  if (!variant.is_ready && variant.fulfillment_type === "QUANTITY_STOCK") {
    buttons.push([
      { text: CATALOG_COPY.restockSubscribe, callbackData: restockSubscribeCallbackData },
    ]);
  }
  buttons.push(
    [{ text: CATALOG_COPY.back, callbackData: "cat:list" }],
    [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
  );
  return { text, buttons };
}

/** Search results; empty matches get a clear empty state, never a fabricated product. */
export function presentSearchResults(
  variants: CatalogVariantRow[],
  nextCursor: string | null,
): PresentedMessage {
  if (variants.length === 0) {
    return {
      text: CATALOG_COPY.emptySearch,
      buttons: [
        [{ text: CATALOG_COPY.search, callbackData: "cat:search" }],
        [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
      ],
    };
  }
  return presentVariantList(variants, { nextCursor, title: "Kết quả tìm kiếm" });
}

/**
 * Typed stock-outcome screen (FR-006b / T157).
 *
 * Shown when Buy Now cannot reserve a unit (empty shelf, race loss, or
 * contention timeout). Copy is truthful (no payment-success wording). Only
 * working recovery actions are offered.
 */
export function presentStockOutcome(code: StockOutcomeCode): PresentedMessage {
  return {
    text: STOCK_OUTCOME_COPY[code],
    buttons: [
      [{ text: CATALOG_COPY.viewAlternatives, callbackData: "cat:list" }],
      [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
    ],
  };
}

function deliveryLabel(type: string): string {
  switch (type) {
    case "INVITE":
      return "Mời tham gia";
    case "LICENSE":
      return "Mã bản quyền";
    case "ACTIVATION_KEY":
      return "Key kích hoạt";
    case "CREDENTIAL":
      return "Tài khoản";
    case "MANUAL_REVIEW":
      return "Xử lý thủ công";
    default:
      return type;
  }
}

function stockLabel(variant: CatalogVariantRow): string {
  if (variant.fulfillment_type === "QUANTITY_STOCK") return `${variant.available_quantity ?? 0}`;
  switch (variant.stock_policy) {
    case "LOCAL_ONLY":
      return variant.is_ready ? "Kho local" : "Hết hàng";
    case "SUPPLIER_ONLY":
      return variant.fulfillment_type === "SUPPLIER_API" && variant.is_ready
        ? "Nhà cung cấp"
        : "Chưa mở bán (nhà cung cấp)";
    case "LOCAL_THEN_SUPPLIER":
      return variant.is_ready ? "Kho local" : "Hết hàng";
    case "PAUSED":
      return "Tạm dừng";
    default:
      return variant.stock_policy;
  }
}
