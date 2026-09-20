import { formatVnd, makeVnd } from "../../shared/money/index.js";
import {
  formatCategoryLabel,
  type InlineButton,
  type PresentedMessage,
  type ReplyKeyboard,
} from "./catalog.js";
import { formatExpiryVietnam } from "./payment.js";
import type { StorefrontProductSummary } from "../../modules/catalog/repository.js";
import {
  preorderPayableLeg,
  type CustomerPreorderSummary,
  type PreorderStatus,
} from "../../modules/commerce/preorder.js";
import {
  COMMUNITY_BUTTON_LABEL,
  SHOP_NAME,
  SHOP_TAGLINE,
  coerceAdminContactUrl,
  coerceCommunityUrl,
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
    [{ text: CUSTOMER_COPY.account }],
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
  adminContactUrl?: string | undefined;
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
    lines.push("", "🔥 Sản phẩm nổi bật");
    for (const product of featured.slice(0, 3)) {
      buttons.push([{ text: `🔥 ${product.name_vi}`, callbackData: `shop:product:${product.id}` }]);
    }
  }
  const categories = options.categories ?? [];
  for (let i = 0; i < categories.length; i += 2) {
    buttons.push(
      categories.slice(i, i + 2).map((category) => ({
        text: formatCategoryLabel(category.name, category.icon),
        callbackData: `cat:view:${category.id}`,
      })),
    );
  }
  buttons.push(
    [{ text: "🔎 Tìm sản phẩm", callbackData: "cat:search" }],
    [
      {
        text: COMMUNITY_BUTTON_LABEL,
        url: coerceCommunityUrl(options.communityUrl),
        callbackData: "",
      },
      {
        text: "👨‍💻 Liên hệ Admin",
        url: coerceAdminContactUrl(options.adminContactUrl),
        callbackData: "",
      },
    ],
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
      "🛡 Chính sách bảo hành & hỗ trợ",
      "",
      summary ?? "Vui lòng liên hệ để được hỗ trợ.",
    ].join("\n"),
    buttons: [
      [
        { text: "💬 Nhắn tin hỗ trợ", callbackData: "supp:open" },
        { text: "🛒 Về trang chủ", callbackData: "shop:home" },
      ],
    ],
  };
}
export function presentCustomerNotificationPreferences(prefs: {
  marketing: boolean;
  socialProof: boolean;
}): PresentedMessage {
  return {
    text: [
      "Cài đặt thông báo",
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
/**
 * The customer's deposit holds (goal: preorder visibility). One screen answers
 * the three questions a depositor actually has: has my deposit been received,
 * where am I in the queue, and by when must I pay the rest. State comes from the
 * reservation row only — nothing here claims a payment that SePay has not
 * confirmed.
 */
const PREORDER_STATUS_LINE: Record<PreorderStatus, string> = {
  CREATED: "⏳ Chưa hoàn tất đặt cọc",
  WAITING_DEPOSIT: "⏳ Chưa nhận được tiền cọc",
  DEPOSIT_PAID: "✅ Đã nhận tiền cọc — đang chờ hàng về",
  ALLOCATED: "📦 Hàng đã về và đang giữ riêng cho bạn",
  BALANCE_DUE: "📦 Hàng đã về, cần thanh toán nốt",
  FULLY_PAID: "🎉 Đã thanh toán đủ — shop đang giao hàng",
  FULFILLED: "✅ Đã giao hàng",
  DEPOSIT_EXPIRED: "❌ Suất đặt cọc đã hết hạn",
  CANCELLED: "🚫 Suất đặt cọc đã huỷ",
  SHOP_CANCELLED: "🚫 Shop đã huỷ suất đặt cọc",
  HOLD_EXPIRED: "❌ Đã hết hạn giữ hàng",
  DEPOSIT_FORFEITED:
    "❌ Quá hạn thanh toán phần còn lại — tiền cọc không được hoàn lại theo điều kiện đã đồng ý",
  REFUND_DUE: "💸 Shop đang xử lý hoàn tiền cọc",
};

export function presentCustomerPreorders(
  preorders: readonly CustomerPreorderSummary[],
): PresentedMessage {
  const lines = ["💰 Đặt cọc của tôi", ""];
  const buttons: InlineButton[][] = [];
  if (preorders.length === 0) {
    lines.push("Bạn chưa có suất đặt cọc nào.");
  }
  for (const preorder of preorders) {
    lines.push(`• ${preorder.productName} · ${preorder.variantName}`);
    lines.push(`   ${PREORDER_STATUS_LINE[preorder.status]}`);
    if (preorder.status === "DEPOSIT_PAID") {
      lines.push(`   Đã cọc: ${formatVnd(makeVnd(BigInt(preorder.depositVnd)))}`);
      const position = preorder.queuePosition;
      lines.push(
        position !== null && position > 0
          ? `   Vị trí hàng chờ: #${position}`
          : "   Đang xếp vào hàng chờ",
      );
    }
    const balanceDueLabel =
      preorder.balanceDueUntil !== null
        ? formatExpiryVietnam(preorder.balanceDueUntil.toISOString())
        : null;
    if (preorder.status === "ALLOCATED" || preorder.status === "BALANCE_DUE") {
      lines.push(`   Còn phải trả: ${formatVnd(makeVnd(BigInt(preorder.balanceVnd)))}`);
      if (balanceDueLabel) lines.push(`   Hạn thanh toán: ${balanceDueLabel}`);
    }
    if (preorder.status === "WAITING_DEPOSIT") {
      lines.push(`   Tiền cọc: ${formatVnd(makeVnd(BigInt(preorder.depositVnd)))}`);
    }
    const leg = preorderPayableLeg(preorder.status);
    if (leg) {
      const amount = leg === "DEPOSIT" ? preorder.depositVnd : preorder.balanceVnd;
      buttons.push([
        {
          text:
            leg === "DEPOSIT"
              ? `🏦 Thanh toán cọc ${formatVnd(makeVnd(BigInt(amount)))}`
              : `🏦 Thanh toán nốt ${formatVnd(makeVnd(BigInt(amount)))}`,
          callbackData: `preorder:pay:${preorder.id}`,
        },
      ]);
    }
    lines.push("");
  }
  buttons.push([
    { text: CUSTOMER_COPY.browse, callbackData: "shop:home" },
    { text: CUSTOMER_COPY.support, callbackData: "supp:open" },
  ]);
  return { text: lines.join("\n").trimEnd(), buttons };
}

/**
 * Customer account home. Retail MVP keeps wallet and top-up controls out of
 * customer-facing navigation; the wallet domain remains an internal backend lane.
 */
export function presentCustomerAccount(input: {
  displayName: string;
  /** Legacy backend input; retail MVP does not render wallet data. */
  balanceVnd?: bigint;
  completedOrders: number;
  shopUpdates: boolean;
  purchaseActivity: boolean;
}): PresentedMessage {
  return {
    text: [
      "👤 Tài khoản khách hàng",
      "",
      `👋 ${input.displayName}`,
      `🧾 Đơn đã hoàn tất: ${input.completedOrders}`,
      `🔔 Thông báo: Cập nhật sản phẩm ${input.shopUpdates ? "Bật" : "Tắt"} · Hoạt động mua hàng ${input.purchaseActivity ? "Bật" : "Tắt"}`,
    ].join("\n"),
    buttons: [
      [
        { text: "🧾 Đơn hàng", callbackData: "ord:list" },
        { text: "📌 Đặt cọc", callbackData: "cust:preorders" },
      ],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        { text: "💬 Hỗ trợ", callbackData: "supp:open" },
      ],
      [{ text: "🔔 Thông báo", callbackData: "cust:notify" }],
      [{ text: "🏠 Trang chủ", callbackData: "shop:home" }],
    ],
  };
}

/**
 * Warranty home (goal §65): the customer's completed orders, each opening a
 * warranty request through the EXISTING support flow (`sup:open:<order>`) — no
 * separate warranty service and no new state.
 */
export function presentCustomerWarrantyHome(
  orders: ReadonlyArray<{ orderNumber: string; productNameVi: string }>,
): PresentedMessage {
  const lines = ["🛡 Bảo hành", ""];
  const buttons: InlineButton[][] = [];
  if (orders.length === 0) {
    lines.push("Bạn chưa có đơn hàng nào đã hoàn tất để bảo hành.");
  } else {
    lines.push("Chọn đơn hàng bạn cần bảo hành:");
    for (const order of orders) {
      lines.push(`• ${order.orderNumber} — ${order.productNameVi}`);
      buttons.push([
        {
          text: `${order.orderNumber} · ${order.productNameVi}`,
          callbackData: `sup:open:${order.orderNumber}`,
        },
      ]);
    }
  }
  buttons.push([{ text: "💬 Hỗ trợ", callbackData: "supp:open" }]);
  return { text: lines.join("\n"), buttons };
}

/**
 * Completed-purchase thank-you (goal §53). Rendered AFTER real fulfilment, as its
 * own message: fulfilment already sent the delivery/credential message, so this
 * carries commercial context only — never a credential value and never a second
 * delivery instruction.
 */
export function presentPurchaseThankYou(input: {
  orderNumber: string;
  productName: string;
}): PresentedMessage {
  return {
    text: [
      "🎉 Cảm ơn bạn đã mua hàng!",
      "",
      `Sản phẩm: ${input.productName} · Đơn: ${input.orderNumber}`,
      "✅ Đơn đã hoàn tất.",
    ].join("\n"),
    buttons: [
      [
        { text: "🧾 Xem đơn", callbackData: `ord:view:${input.orderNumber}` },
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
      ],
      [
        { text: "🛒 Mua thêm", callbackData: "shop:home" },
        { text: "💬 Hỗ trợ", callbackData: `sup:open:${input.orderNumber}` },
      ],
    ],
  };
}
