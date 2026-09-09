import type { InlineButton, PresentedMessage } from "./catalog.js";

/**
 * Vietnamese processing/completed/expired/used/needs-review presenters (T075,
 * FR-017, telegram-ux.md).
 *
 * Delivery presenters never render the secret itself — they link the customer
 * to the authenticated reveal surface (or explain why it is no longer available).
 * Support paths surface a safe correlation reference, never a mark-paid or a
 * credential paste prompt.
 */

export const DELIVERY_COPY = {
  processingTitle: "⏳ Đang xử lý đơn hàng",
  processingBody:
    "Thanh toán đã xác nhận. Hệ thống đang chuẩn bị tài khoản. Bạn sẽ nhận liên kết giao hàng ngay khi sẵn sàng.",
  completedTitle: "✅ Tài khoản đã sẵn sàng",
  completedBody:
    "Nhấn nút bên dưới để xem tài khoản (chỉ xem được một lần, có thời hạn). Không chia sẻ liên kết với người khác.",
  openDelivery: "🔑 Xem tài khoản",
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
} as const;

function nav(orderNumber: string): InlineButton[][] {
  return [
    [{ text: DELIVERY_COPY.viewOrder, callbackData: `ord:view:${orderNumber}` }],
    [{ text: DELIVERY_COPY.mainMenu, callbackData: "menu:main" }],
    [{ text: DELIVERY_COPY.support, callbackData: `sup:open:${orderNumber}` }],
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
 * Delivery Bundle is AVAILABLE. The reveal URL is the authenticated delivery
 * surface — the secret itself is never embedded in the message body as a
 * credential, only as a time-limited link the customer can open once.
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
    "✅ GIAO HÀNG THÀNH CÔNG",
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
    buttons: [
      [{ text: "🧾 Xem đơn", callbackData: `ord:view:${orderNumber}` }],
      [{ text: "🛡 Bảo hành", callbackData: "cust:warranty" }],
      [{ text: "💬 Hỗ trợ", callbackData: `sup:open:${orderNumber}` }],
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

/** Fulfillment needs manual review (invalid asset / supplier unknown). */
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
      [{ text: DELIVERY_COPY.support, callbackData: `sup:open:${orderNumber}` }],
      [{ text: DELIVERY_COPY.mainMenu, callbackData: "menu:main" }],
    ],
  };
}
