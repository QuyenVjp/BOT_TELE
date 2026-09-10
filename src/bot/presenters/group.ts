import type { PresentedMessage } from "./catalog.js";
import { SHOP_NAME, SHOP_TAGLINE, ADMIN_CONTACT_URL } from "../../modules/catalog/shop-profile.js";

/** Group commerce presentation layer (telegram-only group commerce). */

export interface GroupShopPanelOptions {
  botUsername: string;
  hasFeatured?: boolean;
}

export function presentGroupShopPanel(options: GroupShopPanelOptions): PresentedMessage {
  return {
    text: [
      `🛒 *${SHOP_NAME}*`,
      "",
      `_${SHOP_TAGLINE}_`,
      "",
      "⚡ VietQR tự động 24/7",
      "📦 Giao hàng siêu tốc",
      "🛡 Hỗ trợ & bảo hành chính hãng",
    ].join("\n"),
    buttons: [
      [
        { text: "🔥 Sản phẩm hot", callbackData: "grp:hot" },
        { text: "🔎 Tìm trong nhóm", switchInlineQueryCurrentChat: "", callbackData: "" },
      ],
      [
        {
          text: "🛒 Mở Shop riêng",
          url: `https://t.me/${options.botUsername}?start=shop`,
          callbackData: "",
        },
        { text: "👨‍💻 Admin", url: ADMIN_CONTACT_URL, callbackData: "" },
      ],
    ],
  };
}

export interface GroupProductCardInput {
  name: string;
  shortDescription?: string | null;
  priceVnd: number | bigint;
  isOutOfStock: boolean;
  stockLabel: string;
  deliveryTypeLabel: string;
  warrantyText?: string | null;
  productToken: string;
  botUsername: string;
}

export function presentGroupProductCard(input: GroupProductCardInput): PresentedMessage {
  const priceFormatted = Number(input.priceVnd).toLocaleString("vi-VN") + " ₫";
  const stockBadge = input.isOutOfStock ? "🔴" : "🟢";

  const lines = [
    `🔥 *${input.name.toUpperCase()}*`,
    "",
    input.shortDescription ? `_${input.shortDescription}_` : "",
    "",
    `💰 Giá từ: *${priceFormatted}*`,
    `📦 Tình trạng: ${stockBadge} *${input.stockLabel}*`,
    `⚡ Giao hàng: *${input.deliveryTypeLabel}*`,
    input.warrantyText ? `🛡 Bảo hành: _${input.warrantyText}_` : "",
  ].filter(Boolean);

  const buyUrl = `https://t.me/${input.botUsername}?start=p_${input.productToken}`;
  const restockUrl = `https://t.me/${input.botUsername}?start=rst_${input.productToken}`;

  const buttons = input.isOutOfStock
    ? [
        [
          { text: "🔔 Báo khi có hàng", url: restockUrl, callbackData: "" },
          { text: "📋 Chi tiết", url: buyUrl, callbackData: "" },
        ],
        [{ text: "🔎 Tìm trong nhóm", switchInlineQueryCurrentChat: "", callbackData: "" }],
      ]
    : [
        [
          { text: "🛒 Mua riêng", url: buyUrl, callbackData: "" },
          { text: "📋 Chi tiết", url: buyUrl, callbackData: "" },
        ],
        [{ text: "🔎 Tìm trong nhóm", switchInlineQueryCurrentChat: "", callbackData: "" }],
      ];

  return {
    text: lines.join("\n"),
    buttons,
  };
}

export interface GroupWelcomeOptions {
  memberNames: string[];
  botUsername: string;
}

export function presentGroupWelcome(options: GroupWelcomeOptions): PresentedMessage {
  const greeted =
    options.memberNames.length === 1
      ? options.memberNames[0]!
      : `${options.memberNames[0]!} và ${options.memberNames.length - 1} thành viên mới`;

  return {
    text: [
      `👋 Chào mừng *${greeted}* đến với AI Codex Việt Nam!`,
      "",
      `🛒 *${SHOP_NAME}* — _${SHOP_TAGLINE}_`,
      "",
      "Bạn có thể hỏi bot ngay trong nhóm:",
      `• \`@${options.botUsername} claude\``,
      `• \`@${options.botUsername} chatgpt\``,
      `• \`@${options.botUsername} vpn\``,
      "",
      "⚡ Nhập `/shop` để xem bảng sản phẩm nổi bật.",
    ].join("\n"),
    buttons: [
      [
        {
          text: "🛒 Xem Shop",
          url: `https://t.me/${options.botUsername}?start=shop`,
          callbackData: "",
        },
        { text: "👨‍💻 Liên hệ Admin", url: ADMIN_CONTACT_URL, callbackData: "" },
      ],
    ],
  };
}

export function presentGroupPrivacyNotice(
  topic: "orders" | "wallet" | "warranty" | "general",
  botUsername: string,
): PresentedMessage {
  const topicDetails: Record<
    typeof topic,
    { title: string; desc: string; buttonText: string; param: string }
  > = {
    orders: {
      title: "Thông tin đơn hàng được bảo vệ",
      desc: "Để bảo vệ quyền riêng tư và thông tin tài khoản, danh sách đơn hàng chỉ được hiển thị trong cuộc trò chuyện riêng.",
      buttonText: "🧾 Xem đơn riêng",
      param: "orders",
    },
    wallet: {
      title: "Thông tin số dư ví được bảo vệ",
      desc: "Số dư ví và mã thanh toán VietQR chỉ hiển thị trong cuộc trò chuyện riêng của bạn.",
      buttonText: "💰 Mở ví riêng",
      param: "wallet",
    },
    warranty: {
      title: "Yêu cầu bảo hành được bảo mật",
      desc: "Thông tin bảo hành và tài khoản thay thế được xử lý riêng tư để bảo vệ dữ liệu bí mật.",
      buttonText: "🛡 Mở bảo hành riêng",
      param: "warranty",
    },
    general: {
      title: "Thông tin nhạy cảm được bảo vệ",
      desc: "Vui lòng mở chat riêng với bot để tiếp tục thực hiện giao dịch an toàn.",
      buttonText: "🔒 Mở chat riêng",
      param: "start",
    },
  };

  const item = topicDetails[topic];
  return {
    text: [`🔒 *${item.title.toUpperCase()}*`, "", item.desc].join("\n"),
    buttons: [
      [
        {
          text: item.buttonText,
          url: `https://t.me/${botUsername}?start=${item.param}`,
          callbackData: "",
        },
      ],
    ],
  };
}

export interface GroupQAResponseInput {
  answer: string;
  productToken?: string | null;
  botUsername: string;
}

export function presentGroupQAResponse(input: GroupQAResponseInput): PresentedMessage {
  const buttons: Array<
    Array<{
      text: string;
      url?: string;
      callbackData: string;
      switchInlineQueryCurrentChat?: string;
    }>
  > = [];

  if (input.productToken) {
    buttons.push([
      {
        text: "🛒 Mua riêng",
        url: `https://t.me/${input.botUsername}?start=p_${input.productToken}`,
        callbackData: "",
      },
      { text: "🔎 Tìm trong nhóm", switchInlineQueryCurrentChat: "", callbackData: "" },
    ]);
  } else {
    buttons.push([
      {
        text: "🛒 Xem Shop",
        url: `https://t.me/${input.botUsername}?start=shop`,
        callbackData: "",
      },
      { text: "🔎 Tìm trong nhóm", switchInlineQueryCurrentChat: "", callbackData: "" },
    ]);
  }

  return {
    text: [`🤖 *TIER20 ASSISTANT*`, "", input.answer].join("\n"),
    buttons,
  };
}

export interface GroupRestockNoticeInput {
  productName: string;
  variantName: string;
  priceVnd: number | bigint;
  productToken: string;
  botUsername: string;
}

export function presentGroupRestockNotice(input: GroupRestockNoticeInput): PresentedMessage {
  const priceFormatted = Number(input.priceVnd).toLocaleString("vi-VN") + " ₫";
  return {
    text: [
      "🔥 *HÀNG ĐÃ VỀ!*",
      "",
      `📦 *${input.productName}* — _${input.variantName}_`,
      `💰 Giá: *${priceFormatted}*`,
      "🟢 *Đã có hàng trở lại!* Giao tự động ngay sau thanh toán.",
    ].join("\n"),
    buttons: [
      [
        {
          text: "🛒 Mua riêng",
          url: `https://t.me/${input.botUsername}?start=p_${input.productToken}`,
          callbackData: "",
        },
      ],
    ],
  };
}

export interface GroupSocialProofInput {
  customerPseudonym: string; // e.g. #A7F3
  productName: string;
  variantName: string;
  priceVnd: number | bigint;
  productToken: string;
  botUsername: string;
}

export function presentGroupSocialProof(input: GroupSocialProofInput): PresentedMessage {
  const priceFormatted = Number(input.priceVnd).toLocaleString("vi-VN") + " ₫";
  return {
    text: [
      "✅ *VỪA GIAO HÀNG THÀNH CÔNG*",
      "",
      `👤 Khách: *${input.customerPseudonym}*`,
      `📦 *${input.productName}* — _${input.variantName}_`,
      `💰 *${priceFormatted}*`,
      "",
      "Cảm ơn bạn đã tin tưởng TIER20 SHOP ❤️",
    ].join("\n"),
    buttons: [
      [
        {
          text: "🛒 Xem sản phẩm",
          url: `https://t.me/${input.botUsername}?start=p_${input.productToken}`,
          callbackData: "",
        },
      ],
    ],
  };
}

export interface GroupAdminPanelInput {
  chatTitle: string;
  membershipStatus: "NOT_MEMBER" | "MEMBER" | "ADMIN";
  canPin: boolean;
  canManageTopics: boolean;
  shopPanelEnabled: boolean;
  welcomeEnabled: boolean;
  replyMode: string;
  restockEnabled: boolean;
  socialProofMode: string;
}

export function presentGroupAdminPanel(input: GroupAdminPanelInput): PresentedMessage {
  const statusBadge =
    input.membershipStatus === "ADMIN"
      ? "👑 Quản trị viên (Admin)"
      : input.membershipStatus === "MEMBER"
        ? "👤 Thành viên thường"
        : "❌ Chưa tham gia nhóm";

  const pinBadge = input.canPin ? "✅ Có quyền ghim" : "⚠️ Chưa có quyền ghim";
  const topicBadge = input.canManageTopics
    ? "✅ Có quyền quản lý chủ đề"
    : "⚠️ Chưa có quyền chủ đề";

  return {
    text: [
      `📢 *CỘNG ĐỒNG — ${input.chatTitle.toUpperCase()}*`,
      "",
      `Trạng thái bot: *${statusBadge}*`,
      `Quyền hạn: ${pinBadge} • ${topicBadge}`,
      "",
      "⚙️ *Cấu hình tương tác:*",
      `• Bảng Shop ghim: *${input.shopPanelEnabled ? "BẬT" : "TẮT"}*`,
      `• Chào mừng thành viên: *${input.welcomeEnabled ? "BẬT" : "TẮT"}*`,
      `• Chế độ trả lời: *\`${input.replyMode}\`*`,
      `• Thông báo hàng về: *${input.restockEnabled ? "BẬT" : "TẮT"}*`,
      `• Bằng chứng đơn hàng: *\`${input.socialProofMode}\`*`,
    ].join("\n"),
    buttons: [
      [
        { text: "📌 Làm mới bảng ghim", callbackData: "admin:grp:refresh_pin" },
        { text: "🧪 Gửi bài test", callbackData: "admin:grp:test_msg" },
      ],
      [
        { text: "⚙️ Đổi chế độ trả lời", callbackData: "admin:grp:toggle_reply_mode" },
        { text: "📊 Thống kê cộng đồng", callbackData: "admin:grp:stats" },
      ],
      [{ text: "🏠 Quản trị", callbackData: "admin:menu" }],
    ],
  };
}
