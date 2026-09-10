import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { InlineButton, PresentedMessage, ReplyKeyboard } from "./catalog.js";
import type { StorefrontProductSummary } from "../../modules/catalog/repository.js";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_BUTTON_LABEL,
  COMMUNITY_URL,
  SHOP_NAME,
  SHOP_TAGLINE,
} from "../../modules/catalog/shop-profile.js";

export const CUSTOMER_COPY = {
  homeTitle: `🛒 ${SHOP_NAME}`,
  homeBody: SHOP_TAGLINE,
  accountTitle: "👤 Tài khoản",
  accountBody:
    "Chia sẻ số điện thoại để nhận hỗ trợ và cập nhật hồ sơ. Bạn có thể quay lại shop bất cứ lúc nào.",
  shareContact: "📱 Chia sẻ số điện thoại",
  back: "↩️ Quay lại",
  browse: "🛒 Mua hàng",
  orders: "🧾 Đơn hàng",
  account: "👤 Tài khoản",
  topup: "💰 Nạp ví",
  warranty: "🛡 Bảo hành",
  support: "💬 Hỗ trợ",
  purchaseActivity: "📣 Hoạt động mua hàng",
  shopUpdates: "🛍 Cập nhật sản phẩm",
  notifications: "🔔 Cài đặt thông báo",
  restock: "🔔 Báo có hàng",
} as const;
export const MAIN_REPLY_KEYBOARD: ReplyKeyboard = {
  persistent: true,
  resizeKeyboard: true,
  buttons: [
    [{ text: CUSTOMER_COPY.browse }, { text: CUSTOMER_COPY.orders }],
    [{ text: CUSTOMER_COPY.account }, { text: CUSTOMER_COPY.topup }],
    [{ text: CUSTOMER_COPY.warranty }, { text: CUSTOMER_COPY.support }],
  ],
};
export function presentCustomerHelp(): PresentedMessage {
  return {
    text: [
      `🛒 ${SHOP_NAME}`,
      "",
      "/start — Mở TIER20 SHOP",
      "/shop — Xem sản phẩm",
      "/orders — Đơn hàng của tôi",
      "/wallet — Ví của tôi",
      "/warranty — Bảo hành",
      "/support — Hỗ trợ",
      "/settings — Cài đặt",
      "/help — Hướng dẫn",
    ].join("\n"),
    buttons: [[{ text: CUSTOMER_COPY.browse, callbackData: "shop:home" }]],
    replyKeyboard: MAIN_REPLY_KEYBOARD,
  };
}
export function presentCustomerHome(): PresentedMessage {
  return {
    text: [CUSTOMER_COPY.homeTitle, "", CUSTOMER_COPY.homeBody].join("\n"),
    buttons: [],
    replyKeyboard: MAIN_REPLY_KEYBOARD,
  };
}
export function presentCustomerAccountPrompt(): PresentedMessage {
  return {
    text: [CUSTOMER_COPY.accountTitle, "", CUSTOMER_COPY.accountBody].join("\n"),
    buttons: [],
    replyKeyboard: {
      persistent: true,
      resizeKeyboard: true,
      buttons: [
        [{ text: CUSTOMER_COPY.shareContact, requestContact: true }],
        [{ text: CUSTOMER_COPY.back }, { text: CUSTOMER_COPY.browse }],
      ],
    },
  };
}
export interface StorefrontDisplayOptions {
  actorName: string;
  isRootAdmin?: boolean | undefined;
  shopName?: string | undefined;
  shopTagline?: string | undefined;
  communityUrl?: string | undefined;
  categories?: ReadonlyArray<{ id: string; name: string; icon?: string | null }>;
  featuredProducts?: StorefrontProductSummary[];
  products?: StorefrontProductSummary[];
  totalProducts?: number;
  offset?: number;
  limit?: number;
  /** Private social proof: real completed-order count, test/canary excluded. */
  stats?: { completedOrders?: number } | undefined;
  testProducts?: StorefrontProductSummary[];
}
export function presentStorefront(options: StorefrontDisplayOptions): PresentedMessage {
  const name = options.shopName ?? SHOP_NAME;
  const tagline = options.shopTagline ?? CUSTOMER_COPY.homeBody;
  const lines = [
    `👋 Chào ${options.actorName}!`,
    "",
    `🛒 ${name}`,
    tagline,
    "⚡ Thanh toán VietQR tự động",
    "📦 Giao hàng nhanh",
    "🛡 Hỗ trợ & bảo hành",
  ];
  // Private social proof only: a real completed-order count, never a fabricated one and
  // never published anywhere but this customer's own chat.
  const completedOrders = options.stats?.completedOrders ?? 0;
  if (completedOrders > 0) lines.push("", `⭐ ${completedOrders} đơn đã hoàn tất`);
  const buttons: InlineButton[][] = [];
  const featured = options.featuredProducts ?? [];
  if (featured.length) {
    lines.push("", "🔥 SẢN PHẨM NỔI BẬT");
    for (const product of featured.slice(0, 3)) {
      buttons.push([{ text: `🔥 ${product.name_vi}`, callbackData: `shop:product:${product.id}` }]);
    }
  }
  const categories = options.categories ?? [];
  for (let i = 0; i < categories.length; i += 2) {
    buttons.push(
      categories.slice(i, i + 2).map((category) => ({
        text: category.name,
        callbackData: `cat:view:${category.id}`,
      })),
    );
  }
  buttons.push(
    [{ text: "🔎 Tìm sản phẩm", callbackData: "cat:search" }],
    [{ text: COMMUNITY_BUTTON_LABEL, url: COMMUNITY_URL, callbackData: "" }],
    [{ text: "👨‍💻 Liên hệ Admin", url: ADMIN_CONTACT_URL, callbackData: "" }],
  );
  if (options.isRootAdmin) buttons.push([{ text: "🛠 Quản trị", callbackData: "admin:menu" }]);
  return {
    text: lines.join("\n"),
    buttons,
    replyKeyboard: MAIN_REPLY_KEYBOARD,
    installPersistentKeyboard: true,
  };
}
export function presentCustomerWarranty(summary?: string): PresentedMessage {
  return {
    text: [
      "🛡 CHÍNH SÁCH BẢO HÀNH & HỖ TRỢ",
      "",
      summary ?? "Vui lòng liên hệ để được hỗ trợ.",
    ].join("\n"),
    buttons: [
      [{ text: "💬 Nhắn tin hỗ trợ", callbackData: "supp:open" }],
      [{ text: "🛒 Về trang chủ", callbackData: "shop:home" }],
    ],
  };
}
export function presentCustomerNotificationPreferences(prefs: {
  marketing: boolean;
  socialProof: boolean;
}): PresentedMessage {
  return {
    text: [
      "CÀI ĐẶT THÔNG BÁO",
      "",
      `Cập nhật sản phẩm: ${prefs.marketing ? "Bật" : "Tắt"}`,
      `Thông tin đơn hàng: ${prefs.socialProof ? "Bật" : "Tắt"}`,
    ].join("\n"),
    buttons: [
      [
        {
          text: prefs.marketing ? "Tắt cập nhật sản phẩm" : "Bật cập nhật sản phẩm",
          callbackData: `cust:notify:marketing:${prefs.marketing ? "off" : "on"}`,
        },
      ],
      [
        {
          text: prefs.socialProof ? "Tắt thông tin đơn" : "Bật thông tin đơn",
          callbackData: `cust:notify:social:${prefs.socialProof ? "off" : "on"}`,
        },
      ],
      [{ text: CUSTOMER_COPY.back, callbackData: "shop:home" }],
    ],
  };
}
export function presentPurchaseThankYou(input: {
  orderNumber: string;
  productName: string;
  variantName?: string;
  priceVnd?: number;
  amountVnd?: string;
}): PresentedMessage {
  const price =
    input.priceVnd != null
      ? formatVnd(makeVnd(BigInt(input.priceVnd)))
      : input.amountVnd
        ? `${input.amountVnd} ₫`
        : "";
  return {
    text: [
      "CẢM ƠN BẠN ĐÃ MUA HÀNG",
      "",
      input.productName,
      input.variantName,
      `Mã đơn: ${input.orderNumber}`,
      price,
    ]
      .filter(Boolean)
      .join("\n"),
    buttons: [
      [{ text: "🧾 Đơn hàng", callbackData: "ord:list" }],
      [{ text: "🛒 Về trang chủ", callbackData: "shop:home" }],
    ],
  };
}
