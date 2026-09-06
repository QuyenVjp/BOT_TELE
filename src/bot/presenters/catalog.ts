import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { CatalogCategoryRow, CatalogVariantRow } from "../../modules/catalog/repository.js";
import type { StockOutcomeCode } from "../../modules/commerce/buy-now.js";
import { isFeature001SellablePolicy } from "../../modules/catalog/domain.js";

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
  // Last-unit loser (FR-006b): truthful, no payment-success wording. Only
  // actions that actually work are shown. A "notify when restocked" button is
  // intentionally omitted until a durable restock subscription exists
  // (Feature 003) — a dead callback is worse than no button.
  viewAlternatives: "🔎 Xem sản phẩm khác",
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
  /** Optional document media, used for paid ZIP delivery. */
  document?:
    | string
    | {
        kind: "file_path" | "file_id";
        value: string;
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
): PresentedMessage {
  const price = formatVnd(makeVnd(BigInt(variant.price_vnd)));
  const text = [
    `📦 ${variant.product_name_vi}`,
    `Gói: ${variant.name_vi}`,
    `Giá: ${price}`,
    `Thời hạn: ${variant.duration_code ?? "—"}`,
    `Giao hàng: ${deliveryLabel(variant.delivery_type)}`,
    `Bảo hành: ${variant.warranty_days} ngày`,
    `Tồn kho: ${stockLabel(variant.stock_policy)}`,
    "",
    "Nhấn Mua ngay để tạo đơn (1 gói = 1 đơn).",
  ].join("\n");

  const buttons: InlineButton[][] = [];
  if (isFeature001SellablePolicy(variant.stock_policy) && buyNowCallbackData !== undefined) {
    buttons.push([{ text: CATALOG_COPY.buyNow, callbackData: buyNowCallbackData }]);
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
 * working recovery actions are offered:
 *   1. view alternative products (cat:list),
 *   2. main menu.
 *
 * A "notify when restocked" button is intentionally ABSENT until Feature 003
 * delivers a durable restock subscription (opt-in, opt-out, dedupe, restock
 * event, notification delivery). Shipping a dead `stock:notify` callback is
 * worse than no button.
 *
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

function stockLabel(policy: string): string {
  switch (policy) {
    case "LOCAL_ONLY":
      // Honest: local stock is finite. The card does not claim "in stock" —
      // Buy Now is the source of truth; a concurrent buyer can empty it.
      return "Kho local";
    case "SUPPLIER_ONLY":
      // Feature 001 MVP: SUPPLIER_ONLY is not sellable via Buy Now (no
      // pre-payment capacity hold). Label makes that clear so the card is
      // not advertised as purchasable.
      return "Chưa mở bán (nhà cung cấp)";
    case "LOCAL_THEN_SUPPLIER":
      // MVP collapses this to LOCAL_ONLY pre-payment (see data-model). Do not
      // advertise "dự phòng" supplier capacity that the checkout path will not
      // honour when local is empty.
      return "Kho local";
    case "PAUSED":
      return "Tạm dừng";
    default:
      return policy;
  }
}
