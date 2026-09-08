import type { InlineButton, PresentedMessage, ReplyKeyboard } from "./catalog.js";
import type { StorefrontProductSummary } from "../../modules/catalog/repository.js";

export const CUSTOMER_COPY = {
  homeTitle: "🛒 SHOP DIGITAL",
  homeBody:
    "Chọn tác vụ phía dưới. Số điện thoại chỉ được lưu khi bạn tự chia sẻ trong chat riêng.",
  accountTitle: "👤 Tài khoản",
  accountBody:
    "Chia sẻ số điện thoại để nhận hỗ trợ và cập nhật hồ sơ. Bạn có thể quay lại shop bất cứ lúc nào.",
  shareContact: "📱 Chia sẻ số điện thoại",
  back: "↩️ Quay lại",
  browse: "🛒 Mua hàng",
  account: "👤 Tài khoản",
  topup: "💰 Nạp ví",
  orders: "🧾 Đơn hàng",
  purchaseActivity: "📣 Hoạt động mua hàng",
  shopUpdates: "🛍 Cập nhật sản phẩm",
  notifications: "🔔 Cài đặt thông báo",
  restock: "🔔 Báo có hàng",
  support: "🛟 Hỗ trợ",
  openShop: "🌐 Mở cửa hàng",
} as const;

export const MAIN_REPLY_KEYBOARD: ReplyKeyboard = {
  persistent: true,
  resizeKeyboard: true,
  buttons: [
    [{ text: CUSTOMER_COPY.browse }, { text: CUSTOMER_COPY.account }],
    [{ text: CUSTOMER_COPY.topup }, { text: "🛡 Bảo hành" }],
    [{ text: CUSTOMER_COPY.orders }, { text: CUSTOMER_COPY.notifications }],
    [{ text: CUSTOMER_COPY.restock }, { text: CUSTOMER_COPY.support }],
    [{ text: CUSTOMER_COPY.openShop }],
  ],
};

export function presentShopLaunch(url: string): PresentedMessage {
  if (!/^https:\/\//i.test(url)) return presentCustomerHome();
  return {
    text: "🌐 Mở cửa hàng",
    buttons: [
      [
        {
          text: "Mở Mini App",
          callbackData: "shop:open",
          webAppUrl: `${url.replace(/\/$/, "")}/shop`,
        },
      ],
    ],
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
  products: StorefrontProductSummary[];
  totalProducts: number;
  offset: number;
  limit: number;
  stats?:
    | {
        completedOrders?: number | undefined;
        totalCustomers?: number | undefined;
      }
    | undefined;
}

export function presentStorefront(options: StorefrontDisplayOptions): PresentedMessage {
  const shopName = options.shopName ?? "TIER20 DIGITAL SHOP";
  const shopTagline = options.shopTagline ?? "Kho sản phẩm số & dịch vụ AI";
  const communityUrl = options.communityUrl ?? "https://t.me/aicodexvn";

  const lines = [
    `👋 Chào ${options.actorName}!`,
    "",
    `🛒 ${shopName}`,
    `${shopTagline}.`,
    "⚡ Thanh toán tự động",
    "📦 Giao hàng nhanh",
    "🛡 Hỗ trợ & bảo hành theo sản phẩm",
    "",
    "📢 Cộng đồng: AI CODEX VIỆT NAM",
    "",
    "───────────────",
    "🔥 DANH MỤC SẢN PHẨM:",
    "",
  ];

  if (options.products.length === 0) {
    lines.push("Hiện chưa có sản phẩm nào được mở bán.");
  } else {
    for (const p of options.products) {
      const priceFormatted = Number(p.min_price_vnd).toLocaleString("vi-VN") + " ₫";
      const stockText =
        p.total_available > 0
          ? `📦 Còn ${p.total_available}`
          : p.preorder_enabled
            ? "📦 Hết hàng (Nhận đặt cọc giữ suất)"
            : "📦 Hết hàng";
      lines.push(`🔹 ${p.name_vi}`);
      lines.push(`💰 Giá từ: ${priceFormatted}`);
      lines.push(stockText);
      if (p.short_description_vi) {
        lines.push(`ℹ️ ${p.short_description_vi}`);
      }
      lines.push("");
    }
  }

  if (options.stats && options.stats.completedOrders && options.stats.completedOrders > 0) {
    lines.push(`⭐ ${options.stats.completedOrders} đơn đã hoàn tất · 📦 Giao tự động`);
  }

  const buttons: InlineButton[][] = [];

  for (const p of options.products) {
    if (p.total_available > 0) {
      buttons.push([
        {
          text: `🛒 Mua: ${p.name_vi} (${Number(p.min_price_vnd).toLocaleString("vi-VN")} ₫)`,
          callbackData: `shop:product:${p.id}`,
        },
      ]);
    } else if (p.preorder_enabled) {
      buttons.push([
        {
          text: `💰 Đặt cọc: ${p.name_vi}`,
          callbackData: `preorder:consent:${p.primary_variant_id}`,
        },
        {
          text: `🔔 Báo có hàng`,
          callbackData: `restock:sub:${p.primary_variant_id}`,
        },
      ]);
    } else {
      buttons.push([
        {
          text: `🔔 Báo có hàng: ${p.name_vi}`,
          callbackData: `restock:sub:${p.primary_variant_id}`,
        },
      ]);
    }
  }

  const navRow: InlineButton[] = [];
  if (options.offset > 0) {
    const prevOffset = Math.max(0, options.offset - options.limit);
    navRow.push({ text: "⬅️ Trang trước", callbackData: `shop:page:${prevOffset}` });
  }
  if (options.offset + options.limit < options.totalProducts) {
    const nextOffset = options.offset + options.limit;
    navRow.push({ text: "Xem thêm ➡️", callbackData: `shop:page:${nextOffset}` });
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([
    { text: "📢 Tham gia nhóm AI Codex VN", url: communityUrl, callbackData: "community:url" },
  ]);
  buttons.push([
    { text: "👤 Tài khoản", callbackData: "wallet:account" },
    { text: "🧾 Đơn hàng", callbackData: "ord:list" },
  ]);
  buttons.push([
    { text: "💰 Nạp ví", callbackData: "wallet:topup" },
    { text: "🔔 Cài đặt thông báo", callbackData: "cust:notify" },
  ]);
  buttons.push([
    { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
    { text: "💬 Hỗ trợ", callbackData: "supp:open" },
  ]);

  if (options.isRootAdmin) {
    buttons.push([{ text: "🛠 Quản trị", callbackData: "admin:menu" }]);
  }

  return {
    text: lines.join("\n"),
    buttons,
    replyKeyboard: MAIN_REPLY_KEYBOARD,
  };
}

export function presentCustomerWarranty(summary?: string): PresentedMessage {
  return {
    text: [
      "🛡 CHÍNH SÁCH BẢO HÀNH & HỖ TRỢ",
      "",
      summary ?? "• Bảo hành 1 đổi 1 trong suốt thời hạn sử dụng nếu phát sinh lỗi từ hệ thống.",
      "• Hỗ trợ kích hoạt, hướng dẫn sử dụng và xử lý kỹ thuật 24/7.",
      "• Mọi đơn hàng đều lưu nhật ký kiểm toán và hóa đơn điện tử minh bạch.",
      "",
      "Nếu cần hỗ trợ, vui lòng bấm nút bên dưới để liên hệ ban quản trị.",
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
      "🔔 CÀI ĐẶT THÔNG BÁO",
      "",
      "Bạn có thể tùy chỉnh các loại thông báo nhận từ Bot:",
      `• Thông báo sản phẩm mới / Khuyến mãi: ${prefs.marketing ? "🟢 Bật" : "🔴 Tắt"}`,
      `• Cho phép hiển thị mua hàng ẩn danh: ${prefs.socialProof ? "🟢 Bật" : "🔴 Tắt"}`,
      "",
      "Lưu ý: Các thông báo dịch vụ (thanh toán, giao hàng, bảo hành) luôn được gửi để đảm bảo quyền lợi của bạn.",
    ].join("\n"),
    buttons: [
      [
        {
          text: prefs.marketing ? "🔕 Tắt khuyến mãi" : "🔔 Bật khuyến mãi",
          callbackData: `cust:notify:marketing:${prefs.marketing ? "off" : "on"}`,
        },
        {
          text: prefs.socialProof ? "🔒 Ẩn danh hoàn toàn" : "🌐 Bật ẩn danh mua hàng",
          callbackData: `cust:notify:social:${prefs.socialProof ? "off" : "on"}`,
        },
      ],
      [{ text: "🛒 Về trang chủ", callbackData: "shop:home" }],
    ],
  };
}

export function presentPurchaseThankYou(input: {
  orderNumber: string;
  productName: string;
  variantName: string;
  priceVnd: number;
}): PresentedMessage {
  return {
    text: [
      "🎉 CẢM ƠN BẠN ĐÃ MUA HÀNG!",
      "",
      `Đơn hàng: ${input.orderNumber}`,
      `Sản phẩm: ${input.productName} · ${input.variantName}`,
      `Tổng thanh toán: ${input.priceVnd.toLocaleString("vi-VN")} ₫`,
      "",
      "✅ Đơn hàng đã được hoàn tất và giao thành công.",
      "Cảm ơn bạn đã tin tưởng và đồng hành cùng TIER20 ❤️",
    ].join("\n"),
    buttons: [
      [{ text: "🧾 Xem đơn hàng", callbackData: `ord:view:${input.orderNumber}` }],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        { text: "💬 Hỗ trợ", callbackData: "supp:open" },
      ],
      [{ text: "🛒 Mua thêm", callbackData: "shop:home" }],
    ],
  };
}
