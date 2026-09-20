import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";

declare module "./catalog.js" {
  interface PresentedMessage {
    protectContent?: boolean;
  }
}

/**
 * Vietnamese processing/completed/expired/used/needs-review presenters (T075,
 * FR-017, telegram-ux.md).
 *
 * New fulfilled credential bundles are rendered directly in the successful
 * Telegram notification. The legacy `/d/:token` and callback reveal paths
 * remain one-time compatibility/recovery surfaces. Mini App / WebApp reveal is
 * cancelled. Support paths surface a safe correlation reference, never a
 * mark-paid prompt.
 */

export const DELIVERY_COPY = {
  processingTitle: "⏳ Đang xử lý đơn hàng",
  processingBody:
    "Thanh toán đã xác nhận. Hệ thống đang chuẩn bị tài khoản. Bạn sẽ nhận thông tin nhận hàng trực tiếp trong Telegram khi sẵn sàng.",
  completedTitle: "✅ Tài khoản đã sẵn sàng",
  completedBody:
    "Thông tin nhận hàng được gửi trực tiếp trong tin nhắn xác nhận. Nếu cần khôi phục liên kết cũ, vui lòng liên hệ hỗ trợ.",
  openDelivery: "🔐 Mở liên kết cũ",
  expiredTitle: "⏰ Liên kết giao hàng đã hết hạn",
  expiredBody:
    "Liên kết đã quá thời hạn trước khi được mở. Vui lòng liên hệ hỗ trợ để được cấp lại (nếu đủ điều kiện).",
  usedTitle: "📦 Tài khoản đã được giao",
  usedBody:
    "Liên kết đã được mở trước đó. Nếu bạn chưa nhận được tài khoản, vui lòng mở ticket hỗ trợ với mã tham chiếu bên dưới.",
  reviewTitle: "🔎 Đơn hàng cần kiểm tra",
  reviewBody:
    "Giao hàng đang được đối soát. Vui lòng chờ hoặc liên hệ hỗ trợ với mã tham chiếu. Không gửi mật khẩu hay ảnh chụp màn hình chứa thông tin đăng nhập.",
  support: "💬 Hỗ trợ",
  mainMenu: "Menu chính",
  viewOrder: "📦 Xem đơn",
  deleteAfterSave: "🗑 Đã lưu, xóa tin nhắn",
} as const;

function nav(orderNumber: string): InlineButton[][] {
  return [
    [{ text: DELIVERY_COPY.viewOrder, callbackData: `ord:view:${orderNumber}` }],
    [
      { text: DELIVERY_COPY.support, callbackData: `sup:open:${orderNumber}` },
      { text: DELIVERY_COPY.mainMenu, callbackData: "menu:main" },
    ],
  ];
}

/** Paid Order is being fulfilled (local claim or supplier provisioning). */
export function presentDeliveryProcessing(orderNumber: string): PresentedMessage {
  return {
    text: [
      DELIVERY_COPY.processingTitle,
      "",
      `Đơn: ${orderNumber}`,
      DELIVERY_COPY.processingBody,
    ].join("\n"),
    buttons: nav(orderNumber),
  };
}

/**
 * Legacy Delivery Bundle URL presenter. New handoffs use
 * `presentDeliveryReveal` after the worker has sent customer-visible fields.
 * This compatibility presenter never embeds a credential, only a time-limited
 * link the customer can open once.
 */
export interface DeliveryCredentialField {
  name: string;
  label: string;
  value: string;
  secret?: boolean;
  customerVisible?: boolean;
}

export interface DeliveryCompletedOptions {
  productName?: string;
  fulfillmentType?: string;
  fields?: DeliveryCredentialField[];
  code?: string;
  usageInstructionsVi?: string | null;
  warrantyVi?: string | null;
}

export function presentDeliveryCompleted(
  orderNumber: string,
  deliveryUrl: string,
  options?: DeliveryCompletedOptions,
): PresentedMessage {
  const lines = [
    "✅ Giao hàng thành công",
    "",
    options?.productName ?? "Sản phẩm",
    `Đơn: ${orderNumber}`,
  ];
  const fields = options?.fields?.filter((field) => field.customerVisible !== false) ?? [];
  if (options?.code) lines.push(`🔑 Mã: ${options.code}`);
  for (const field of fields)
    lines.push(`${field.secret ? "🔐 " : "👤 "}${field.label}: ${field.value}`);
  if (options?.usageInstructionsVi) lines.push("", `📘 Hướng dẫn: ${options.usageInstructionsVi}`);
  if (options?.warrantyVi) lines.push("", `🛡 Bảo hành: ${options.warrantyVi}`);
  lines.push("", deliveryUrl);
  return {
    text: lines.join("\n"),
    protectContent: true,
    buttons: [
      [{ text: DELIVERY_COPY.deleteAfterSave, callbackData: "delivery:delete" }],
      [{ text: "🧾 Xem đơn", callbackData: `ord:view:${orderNumber}` }],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        { text: "💬 Hỗ trợ", callbackData: `sup:open:${orderNumber}` },
      ],
    ],
  };
}

/** Bundle expired before first view. */
export function presentDeliveryExpired(orderNumber: string): PresentedMessage {
  return {
    text: [DELIVERY_COPY.expiredTitle, "", `Đơn: ${orderNumber}`, DELIVERY_COPY.expiredBody].join(
      "\n",
    ),
    buttons: nav(orderNumber),
  };
}

/** Bundle already consumed (view-once). */
export function presentDeliveryUsed(orderNumber: string): PresentedMessage {
  return {
    text: [DELIVERY_COPY.usedTitle, "", `Đơn: ${orderNumber}`, DELIVERY_COPY.usedBody].join("\n"),
    buttons: nav(orderNumber),
  };
}

/** Customer-visible credential fields for automatic or legacy Telegram delivery. */
export function presentDeliveryReveal(input: {
  secret: string;
  productName: string | null;
  orderNumber?: string | null;
  amountVnd?: string | null;
  usageInstructionsVi: string | null;
  warrantyVi: string | null;
}): PresentedMessage {
  const lines = ["✅ Giao hàng thành công", "", input.productName ?? "Sản phẩm"];
  if (input.orderNumber) lines.push(`Đơn: ${input.orderNumber}`);
  if (input.amountVnd) lines.push(`💰 ${formatVnd(makeVnd(BigInt(input.amountVnd)))}`);
  lines.push("", "🔐 Thông tin nhận hàng:", input.secret);
  if (input.usageInstructionsVi) lines.push("", `📘 Hướng dẫn: ${input.usageInstructionsVi}`);
  if (input.warrantyVi) lines.push("", `🛡 Bảo hành: ${input.warrantyVi}`);
  return {
    text: lines.join("\n"),
    protectContent: true,
    buttons: [
      [
        {
          text: "🧾 Đơn hàng",
          callbackData: input.orderNumber ? `ord:view:${input.orderNumber}` : "ord:list",
        },
      ],
      [{ text: DELIVERY_COPY.deleteAfterSave, callbackData: "delivery:delete" }],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        {
          text: "💬 Hỗ trợ",
          callbackData: input.orderNumber ? `sup:open:${input.orderNumber}` : "sup:open",
        },
      ],
    ],
  };
}

export function presentDeliveryNeedsReview(
  orderNumber: string,
  correlationId: string,
): PresentedMessage {
  return {
    text: [
      DELIVERY_COPY.reviewTitle,
      "",
      `Đơn: ${orderNumber}`,
      DELIVERY_COPY.reviewBody,
      `Mã tham chiếu: ${correlationId}`,
    ].join("\n"),
    buttons: [
      [
        { text: DELIVERY_COPY.support, callbackData: `sup:open:${orderNumber}` },
        { text: DELIVERY_COPY.mainMenu, callbackData: "menu:main" },
      ],
    ],
  };
}
