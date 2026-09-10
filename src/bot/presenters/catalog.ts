import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type {
  CatalogCategoryRow,
  CatalogVariantRow,
  PublicCategoryPage,
  ProductDetailView,
  StorefrontProductSummary,
} from "../../modules/catalog/repository.js";
import type { StockOutcomeCode } from "../../modules/commerce/buy-now.js";
import { isSupportedCatalogRoute } from "../../modules/catalog/domain.js";
import { ADMIN_CONTACT_URL, SHOP_NAME } from "../../modules/catalog/shop-profile.js";
import { WARRANTY_BLOCK_LINES } from "./warranty.js";

/**
 * Authoritative product-card presenters + Vietnamese state/error copy (FR-001–FR-003,
 * telegram-ux.md Presentation rules).
 *
 * Every card is built ONLY from catalog repository rows — the presenter never invents
 * a price, duration, warranty, or availability claim. Free text from search is never
 * rendered as a product fact (FR-005).
 */

export const CATALOG_COPY = {
  mainMenuTitle: `🛒 ${SHOP_NAME}`,
  browse: "🛍 Danh sách sản phẩm",
  searchAgain: "🔎 Tìm lại",
  orders: "📦 Đơn hàng",
  support: "💬 Hỗ trợ",
  back: "Quay lại",
  mainMenu: "🏠 Trang chủ",
  buyNow: "Mua ngay",
  emptyCatalog: "Hiện chưa có sản phẩm nào đang bán.",
  emptyCategory: "Hiện chưa có sản phẩm trong mục này.",
  emptySearch: "Không tìm thấy sản phẩm phù hợp.",
  rateLimited: "Bạn thao tác hơi nhanh. Vui lòng thử lại sau giây lát.",
  genericError: "Có lỗi xảy ra. Vui lòng thử lại hoặc liên hệ hỗ trợ.",
  viewAlternatives: "🔎 Xem sản phẩm khác",
  restockSubscribe: "🔔 Báo khi có hàng",
  contactAdmin: "👨‍💻 Liên hệ Admin",
} as const;

export interface InlineButton {
  text: string;
  callbackData: string;
  url?: string;
  switchInlineQueryCurrentChat?: string;
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
  /**
   * Set only where the persistent customer keyboard should be (re)installed — the /start
   * storefront greeting. Telegram delivers one `reply_markup` per message, so a screen that
   * also carries inline buttons needs a second message for the keyboard; asking for that on
   * every such screen would post a redundant menu message each time.
   */
  installPersistentKeyboard?: boolean;
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

function adminContactButton(): InlineButton {
  return { text: CATALOG_COPY.contactAdmin, url: ADMIN_CONTACT_URL, callbackData: "" };
}

function homeButton(callbackData: string): InlineButton {
  return { text: CATALOG_COPY.mainMenu, callbackData };
}

/** Legacy compact menu. Live customer home is presentStorefront. */
export function presentMainMenu(): PresentedMessage {
  return {
    text: CATALOG_COPY.mainMenuTitle,
    buttons: [[{ text: "🔎 Tìm sản phẩm", callbackData: "cat:search" }], [homeButton("shop:home")]],
  };
}

export function presentSearchPrompt(): PresentedMessage {
  return {
    text: [
      "🔎 TÌM SẢN PHẨM",
      "",
      "Gửi tên sản phẩm ngay bây giờ, ví dụ:",
      "gpt • chatgpt • claude • cursor • vpn",
    ].join("\n"),
    buttons: [[homeButton("shop:home")]],
  };
}

/** Active category list. */
export function presentCategoryList(categories: CatalogCategoryRow[]): PresentedMessage {
  if (categories.length === 0) {
    return {
      text: CATALOG_COPY.emptyCatalog,
      buttons: [[homeButton("menu:main")]],
    };
  }
  const buttons: InlineButton[][] = categories.map((c) => [
    { text: c.name_vi, callbackData: `cat:view:${c.id}` },
  ]);
  buttons.push([homeButton("menu:main")]);
  return { text: "Chọn danh mục:", buttons };
}

export function presentCategoryPage(page: PublicCategoryPage): PresentedMessage {
  const title = page.category.display_name_vi || page.category.name_vi;
  const hasItems = page.children.length > 0 || page.products.length > 0 || page.featured.length > 0;
  const lines = [`🛒 ${SHOP_NAME}`, title];
  const buttons: InlineButton[][] = [];
  if (!hasItems) {
    lines.push("", CATALOG_COPY.emptyCategory);
  }
  if (page.featured.length > 0 && page.children.length > 0) {
    lines.push("", "🔥 Nổi bật");
    for (const product of page.featured) {
      buttons.push([
        {
          text: `🔥 ${product.name_vi}`,
          callbackData: `shop:product:${product.id}`,
        },
      ]);
    }
  }
  if (page.children.length > 0) {
    lines.push("", "Chọn thương hiệu:");
  }
  for (let i = 0; i < page.children.length; i += 2) {
    buttons.push(
      page.children.slice(i, i + 2).map((child) => ({
        text: child.display_name_vi || child.name_vi,
        callbackData: `cat:view:${child.id}`,
      })),
    );
  }
  if (page.products.length > 0) {
    lines.push("", "Các gói đang bán:");
  }
  for (const product of page.products) {
    const price = formatVnd(makeVnd(BigInt(product.min_price_vnd)));
    buttons.push([
      {
        text: `${product.name_vi} · ${price}`,
        callbackData: `shop:product:${product.id}`,
      },
    ]);
  }
  if (page.totalPages > 1) {
    const current = Math.min(Math.max(0, page.page), page.totalPages - 1);
    const base = `cat:view:${page.category.id}`;
    buttons.push([
      { text: "⬅️", callbackData: `${base}:${Math.max(0, current - 1)}` },
      // Page indicator: re-opens the current page, so tapping it is a no-op.
      { text: `${current + 1}/${page.totalPages}`, callbackData: `${base}:${current}` },
      { text: "➡️", callbackData: `${base}:${Math.min(page.totalPages - 1, current + 1)}` },
    ]);
  }
  const back = page.parent
    ? {
        text: `⬅️ ${page.parent.display_name_vi || page.parent.name_vi}`,
        callbackData: `cat:view:${page.parent.id}`,
      }
    : homeButton("shop:home");
  buttons.push([back]);
  buttons.push([{ text: "🔎 Tìm sản phẩm", callbackData: "cat:search" }]);
  if (page.parent) buttons.push([homeButton("shop:home")]);
  return { text: lines.join("\n"), buttons };
}

export function presentProductDetail(
  detail: ProductDetailView,
  buyNowByVariantId: Record<string, string | undefined>,
): PresentedMessage {
  const prices = detail.variants.map((v) => BigInt(v.price_vnd)).filter((p) => p > 0n);
  const minPrice = prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : null;
  const anyReady = detail.variants.some((v) => v.is_ready);
  const totalQty = detail.variants.reduce(
    (sum, v) => sum + (v.available_quantity ?? (v.is_ready ? 1 : 0)),
    0,
  );
  const deliveryModes = [
    ...new Set(detail.variants.map((v) => DELIVERY_MODE_COPY[v.fulfillment_type] ?? "Tự động")),
  ];

  const lines = [
    `📦 ${detail.name_vi}`,
    ...(detail.short_description_vi ? [detail.short_description_vi] : []),
    "",
    ...(minPrice != null ? [`💰 Giá từ: ${formatVnd(makeVnd(minPrice))}`] : []),
    stockStateLine(anyReady, totalQty > 0 && totalQty <= 3),
    `⚡ Giao hàng: ${deliveryModes.join(" / ") || "Tự động"}`,
    `⏱ Dự kiến: ${detail.delivery_eta_vi || "vài giây sau khi thanh toán"}`,
  ];

  if (detail.description_vi) {
    lines.push("", "📝 MÔ TẢ", detail.description_vi);
  }
  if (detail.what_customer_receives_vi) {
    lines.push("", "📦 BẠN NHẬN ĐƯỢC", ...bulletLines(detail.what_customer_receives_vi));
  }
  if (detail.usage_instructions_vi) {
    lines.push("", "📘 HƯỚNG DẪN", ...bulletLines(detail.usage_instructions_vi));
  }
  // Goal §5/§62: a warranty-enabled variant gets the canonical block and a way to read the
  // structured policy; the free-text field stays as an extra note when the shop filled it in.
  const warrantyVariant = detail.variants.find(
    (variant) => variant.warranty_enabled === true && variant.warranty_days > 0,
  );
  if (warrantyVariant) {
    lines.push("", ...WARRANTY_BLOCK_LINES);
    if (detail.warranty_vi) lines.push("", detail.warranty_vi);
  } else if (detail.warranty_vi) {
    lines.push("", "🛡 BẢO HÀNH", detail.warranty_vi);
  }

  lines.push("", "Chọn gói thời hạn:");
  const buttons: InlineButton[][] = [];
  if (warrantyVariant) {
    buttons.push([
      {
        text: "📘 Xem chính sách bảo hành",
        callbackData: `warranty:policy:${warrantyVariant.id}`,
      },
    ]);
  }
  for (const variant of detail.variants) {
    const price = formatVnd(makeVnd(BigInt(variant.price_vnd)));
    const buyNow = buyNowByVariantId[variant.id];
    const canBuy =
      variant.is_ready &&
      Boolean(buyNow) &&
      isSupportedCatalogRoute({
        stockPolicy: variant.stock_policy,
        fulfillmentType: variant.fulfillment_type,
      });
    if (canBuy && buyNow) {
      buttons.push([{ text: `${variant.name_vi} · ${price}`, callbackData: buyNow }]);
      continue;
    }
    buttons.push([
      {
        text: `🔔 ${variant.name_vi} · Báo khi có hàng`,
        callbackData: `rst:sub:${variant.id}`,
      },
    ]);
    if (variant.preorder_enabled) {
      buttons.push([
        {
          text: `💰 ${variant.name_vi} · Đặt cọc giữ suất`,
          callbackData: `preorder:consent:${variant.id}`,
        },
      ]);
    }
  }
  buttons.push([{ text: CATALOG_COPY.support, callbackData: "supp:open" }]);
  buttons.push([adminContactButton()]);
  buttons.push([
    {
      text: `⬅️ ${detail.category_name}`,
      callbackData: `cat:view:${detail.category_id}`,
    },
  ]);
  buttons.push([homeButton("shop:home")]);
  return { text: lines.join("\n"), buttons };
}

/** Paginated sellable variant cards. */
export /** Customer-facing names for the backend's duration codes (goal §26). */
const DURATION_LABELS: Record<string, string> = {
  P1M: "1 tháng",
  P3M: "3 tháng",
  P6M: "6 tháng",
  P12M: "12 tháng",
  P24M: "24 tháng",
  P1Y: "12 tháng",
  LIFETIME: "Vĩnh viễn",
  CUSTOM: "Tùy chọn",
  TRIAL: "Dùng thử",
};

function durationLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return DURATION_LABELS[code.toUpperCase()] ?? null;
}

function presentVariantList(
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
    // Duration codes are backend vocabulary (goal §26): the row said "P1M". An unrecognised code is
    // dropped rather than printed raw — the variant name on the same line already names the offer.
    const duration = durationLabel(v.duration_code);
    const details = [price, duration, deliveryLabel(v.delivery_type)].filter(Boolean).join(" · ");
    return `${i + 1}. ${v.product_name_vi} — ${v.name_vi}\n   ${details}`;
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

/** Product detail with commercial fields and Vietnamese delivery copy. */
export function presentVariantDetail(
  variant: CatalogVariantRow,
  buyNowCallbackData?: string,
  restockSubscribeCallbackData = `rst:sub:${variant.id}`,
  preorderCallbackData?: string,
): PresentedMessage {
  const price = formatVnd(makeVnd(BigInt(variant.price_vnd)));
  const compareAt =
    variant.compare_at_price_vnd == null
      ? null
      : formatVnd(makeVnd(BigInt(variant.compare_at_price_vnd)));
  const fulfillment = fulfillmentLabel(variant.fulfillment_type);
  const eta = variant.delivery_eta_vi ?? deliveryEtaFallback(variant.fulfillment_type);
  const textLines = [
    `📦 ${variant.product_name_vi}`,
    `Gói: ${variant.name_vi}`,
    `💰 Giá: ${price}${compareAt ? ` ~~${compareAt}~~` : ""}`,
    stockStateLine(
      variant.is_ready,
      variant.available_quantity != null && variant.available_quantity <= 2,
    ),
    `⚡ Giao hàng: ${DELIVERY_MODE_COPY[variant.fulfillment_type] ?? "Tự động"}`,
    `⏱ Dự kiến: ${eta}`,
  ];
  if (variant.description_vi) textLines.push("", "📝 MÔ TẢ", variant.description_vi);
  if (variant.what_customer_receives_vi) {
    textLines.push("", "📦 BẠN NHẬN ĐƯỢC", ...bulletLines(variant.what_customer_receives_vi));
  }
  if (variant.usage_instructions_vi)
    textLines.push("", "📘 HƯỚNG DẪN", ...bulletLines(variant.usage_instructions_vi));
  if (variant.warranty_vi) textLines.push("", "🛡 BẢO HÀNH", variant.warranty_vi);
  textLines.push(`Thời hạn: ${variant.duration_code ?? "—"}`, `Loại giao: ${fulfillment}`);

  const buttons: InlineButton[][] = [];
  if (
    variant.is_ready &&
    isSupportedCatalogRoute({
      stockPolicy: variant.stock_policy,
      fulfillmentType: variant.fulfillment_type,
    }) &&
    buyNowCallbackData !== undefined
  ) {
    buttons.push([{ text: `🛒 ${CATALOG_COPY.buyNow}`, callbackData: buyNowCallbackData }]);
  }
  if (!variant.is_ready) {
    const preorder =
      preorderCallbackData ??
      (variant.preorder_enabled ? `preorder:consent:${variant.id}` : undefined);
    if (preorder) buttons.push([{ text: "💰 Đặt cọc giữ suất", callbackData: preorder }]);
    buttons.push([
      { text: CATALOG_COPY.restockSubscribe, callbackData: restockSubscribeCallbackData },
    ]);
  }
  buttons.push([{ text: CATALOG_COPY.support, callbackData: "supp:open" }]);
  buttons.push([adminContactButton()]);
  if (variant.category_id) {
    buttons.push([
      { text: `⬅️ ${CATALOG_COPY.back}`, callbackData: `cat:view:${variant.category_id}` },
    ]);
  }
  buttons.push([homeButton("shop:home")]);
  return { text: textLines.join("\n"), buttons };
}

function bulletLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `• ${line}`);
}

/** The three customer-facing stock states; a raw enum or `Tạm hết hàng` never renders. */
function stockStateLine(ready: boolean, lowStock: boolean): string {
  if (!ready) return "🔴 Tình trạng: Hết hàng";
  return lowStock ? "🟡 Tình trạng: Sắp hết hàng" : "🟢 Tình trạng: Còn hàng";
}

/** Delivery wording per fulfillment type — mirrors the checkout screen; enums stay backend-only. */
const DELIVERY_MODE_COPY: Readonly<Record<string, string>> = Object.freeze({
  STOCK_ACCOUNT: "Tự động",
  STOCK_CODE: "Tự động",
  DIGITAL_FILE: "Tự động (tệp số)",
  QUANTITY_STOCK: "Tự động",
  UNLIMITED_SERVICE: "Kích hoạt sau khi thanh toán",
  MANUAL_FULFILLMENT: "Nhân viên xử lý",
  SUPPLIER_API: "Tự động (nhà cung cấp)",
});

function fulfillmentLabel(type: string): string {
  switch (type) {
    case "STOCK_ACCOUNT":
      return "Tài khoản";
    case "STOCK_CODE":
      return "Mã kích hoạt";
    case "DIGITAL_FILE":
      return "Tệp số";
    case "SUPPLIER_API":
      return "Nhà cung cấp";
    case "QUANTITY_STOCK":
      return "Số lượng";
    case "UNLIMITED_SERVICE":
      return "Không giới hạn";
    case "MANUAL_FULFILLMENT":
      return "Xử lý thủ công";
    default:
      return "Sản phẩm số";
  }
}

function deliveryEtaFallback(type: string): string {
  if (type === "MANUAL_FULFILLMENT") return "Xử lý thủ công";
  if (type === "UNLIMITED_SERVICE") return "Theo lịch dịch vụ";
  return "Ngay sau khi thanh toán";
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
        [{ text: CATALOG_COPY.searchAgain, callbackData: "cat:search" }],
        [homeButton("menu:main")],
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
      [homeButton("menu:main")],
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
      return "Sản phẩm số";
  }
}

export type { StorefrontProductSummary };
