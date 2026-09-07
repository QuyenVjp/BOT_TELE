import type { PresentedMessage, ReplyKeyboard } from "./catalog.js";

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
