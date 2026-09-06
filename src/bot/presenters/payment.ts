import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { toBuffer } from "qrcode";
import type { PaymentPresentation } from "../../modules/payments/vietqr.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";

/**
 * Vietnamese payment/expiry/review presenters (T055, FR-008, telegram-ux.md).
 *
 * The payment screen shows EXACT amount, transfer content, and expiry, and
 * explicitly states that no receipt screenshot is required. Settlement is never
 * asserted from the QR — only from verified SePay evidence (the settled screen).
 * Status refresh is a pure internal-projection read; it never polls the provider
 * or marks paid.
 */

export const PAYMENT_COPY = {
  title: "💳 Thanh toán đơn hàng",
  amountLabel: "Số tiền",
  accountLabel: "Số tài khoản",
  contentLabel: "Nội dung CK",
  expiresLabel: "Hết hạn",
  noScreenshot: "Không cần gửi ảnh biên lai. Hệ thống tự nhận diện giao dịch chuyển khoản.",
  instruction: "Quét mã VietQR hoặc chuyển khoản đúng số tiền + nội dung trên.",
  refresh: "🔄 Kiểm tra trạng thái",
  cancel: "Huỷ đơn",
  reopen: "Tạo lại QR",
  support: "💬 Hỗ trợ",
  mainMenu: "Menu chính",
  expiredTitle: "⏰ Mã thanh toán đã hết hạn",
  expiredBody: "Đơn hàng đã quá thời gian chờ thanh toán. Bạn có thể tạo lại QR hoặc huỷ đơn.",
  settledTitle: "✅ Đã thanh toán",
  settledBody: "Đơn hàng đã được xác nhận thanh toán. Chúng tôi sẽ giao tài khoản ngay.",
  reviewTitle: "🔎 Đang kiểm tra giao dịch",
  reviewBody:
    "Giao dịch cần đối soát thủ công. Vui lòng chờ hoặc liên hệ hỗ trợ với mã tham chiếu bên dưới. Không gửi ảnh biên lai.",
} as const;

function navButtons(orderNumber: string): InlineButton[][] {
  return [
    [{ text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" }],
    [{ text: PAYMENT_COPY.support, callbackData: `sup:open:${orderNumber}` }],
  ];
}

/**
 * Human-facing expiry in Asia/Ho_Chi_Minh (UTC+7), e.g. "16/07/2026 19:15 (GMT+7)".
 * Vietnamese buyers must not be shown a UTC clock (T149 finding).
 */
export function formatExpiryVietnam(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Asia/Ho_Chi_Minh is fixed UTC+7 year-round (no DST).
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")} (GMT+7)`;
}

/**
 * Payment screen after Buy Now / reopen. Shows exact amount/content/expiry +
 * the no-screenshot line. Callbacks bind to the order number so the checkout
 * layer can re-resolve the live intent without smuggling state in the message.
 */
export async function presentPaymentScreen(presentation: PaymentPresentation): Promise<PresentedMessage> {
  const amount = formatVnd(makeVnd(presentation.amountVnd));
  const bankLine = presentation.bankName
    ? `${PAYMENT_COPY.accountLabel}: ${presentation.accountNumber} — ${presentation.bankName} (${presentation.accountName})`
    : `${PAYMENT_COPY.accountLabel}: ${presentation.accountNumber} (${presentation.accountName})`;
  const text = [
    PAYMENT_COPY.title,
    "",
    `Đơn: ${presentation.orderNumber}`,
    `${PAYMENT_COPY.amountLabel}: ${amount}`,
    bankLine,
    `${PAYMENT_COPY.contentLabel}: ${presentation.transferContent}`,
    `${PAYMENT_COPY.expiresLabel}: ${formatExpiryVietnam(presentation.expiresAt)}`,
    "",
    PAYMENT_COPY.instruction,
    PAYMENT_COPY.noScreenshot,
  ].join("\n");

  return {
    text,
    photo: await toBuffer(presentation.payload, { type: "png", errorCorrectionLevel: "M" }),
    buttons: [
      [{ text: PAYMENT_COPY.refresh, callbackData: `pay:refresh:${presentation.orderNumber}` }],
      [{ text: PAYMENT_COPY.cancel, callbackData: `pay:cancel:${presentation.orderNumber}` }],
      ...navButtons(presentation.orderNumber),
    ],
  };
}

/** Expired intent / order: offer reopen or cancel. No screenshot instruction. */
export function presentPaymentExpired(orderNumber: string): PresentedMessage {
  return {
    text: [PAYMENT_COPY.expiredTitle, "", `Đơn: ${orderNumber}`, PAYMENT_COPY.expiredBody].join(
      "\n",
    ),
    buttons: [
      [{ text: PAYMENT_COPY.reopen, callbackData: `pay:reopen:${orderNumber}` }],
      [{ text: PAYMENT_COPY.cancel, callbackData: `pay:cancel:${orderNumber}` }],
      ...navButtons(orderNumber),
    ],
  };
}

/** Settled confirmation — only shown after SePay evidence settles the order. */
export function presentPaymentSettled(orderNumber: string): PresentedMessage {
  return {
    text: [PAYMENT_COPY.settledTitle, "", `Đơn: ${orderNumber}`, PAYMENT_COPY.settledBody].join(
      "\n",
    ),
    buttons: [
      [{ text: "📦 Xem đơn", callbackData: `ord:view:${orderNumber}` }],
      ...navButtons(orderNumber),
    ],
  };
}

/**
 * Needs-review screen. Surfaces a safe correlation/reference for support and a
 * support path — never a mark-paid control.
 */
export function presentPaymentNeedsReview(
  orderNumber: string,
  correlationId: string,
): PresentedMessage {
  return {
    text: [
      PAYMENT_COPY.reviewTitle,
      "",
      `Đơn: ${orderNumber}`,
      PAYMENT_COPY.reviewBody,
      `Mã tham chiếu: ${correlationId}`,
    ].join("\n"),
    buttons: [
      [{ text: PAYMENT_COPY.support, callbackData: `sup:open:${orderNumber}` }],
      [{ text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" }],
    ],
  };
}
