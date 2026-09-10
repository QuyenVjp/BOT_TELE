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
  previewTitle: "🛒 XÁC NHẬN ĐƠN HÀNG",
  amountLabel: "Số tiền",
  accountLabel: "Số tài khoản",
  contentLabel: "Nội dung CK",
  expiresLabel: "Hết hạn",
  noScreenshot: "Không cần gửi ảnh biên lai. Hệ thống tự nhận diện giao dịch chuyển khoản.",
  instruction: "Quét mã VietQR hoặc chuyển khoản đúng số tiền + nội dung trên.",
  refresh: "🔄 Kiểm tra trạng thái",
  cancel: "Huỷ đơn",
  reopen: "🛒 Tạo lại thanh toán",
  support: "💬 Hỗ trợ",
  mainMenu: "Menu chính",
  expiredTitle: "⌛ Yêu cầu thanh toán đã hết hạn.",
  expiredBody:
    "Đơn hàng đã quá thời gian chờ thanh toán. Bạn có thể tạo lại thanh toán hoặc xem đơn.",
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

/** Human-facing date-time in Asia/Ho_Chi_Minh (UTC+7), e.g. "16/07/2026 19:15". */
function formatVietnamDateTime(value: Date): string {
  // Asia/Ho_Chi_Minh is fixed UTC+7 year-round (no DST).
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/**
 * Human-facing expiry in Asia/Ho_Chi_Minh (UTC+7), e.g. "16/07/2026 19:15 (GMT+7)".
 * Vietnamese buyers must not be shown a UTC clock (T149 finding).
 */
export function formatExpiryVietnam(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatVietnamDateTime(d)} (GMT+7)`;
}

/**
 * Payment screen after Buy Now / reopen. Shows exact amount/content/expiry +
 * the no-screenshot line. Callbacks bind to the order number so the checkout
 * layer can re-resolve the live intent without smuggling state in the message.
 */
export async function presentPaymentScreen(
  presentation: PaymentPresentation,
): Promise<PresentedMessage> {
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

/**
 * Preorder deposit / balance payment screen. Shows the SAME truth as the order
 * screen (exact amount, transfer content, deadline) but for a deposit hold, and
 * it never says "thành công" — the deposit counts only once SePay confirms it.
 */
export interface PreorderPaymentScreenInput {
  productName: string;
  variantName: string;
  /** Deposit (queue hold) or the remaining balance owed once stock is allocated. */
  leg: "DEPOSIT" | "BALANCE";
  depositVnd: bigint;
  balanceVnd: bigint;
  presentation: PaymentPresentation;
  /** Reservation id the refresh/back callbacks resolve against. */
  reservationId: string;
}

export async function presentPreorderPaymentScreen(
  input: PreorderPaymentScreenInput,
): Promise<PresentedMessage> {
  const amount = formatVnd(makeVnd(input.presentation.amountVnd));
  const bankLine = input.presentation.bankName
    ? `${PAYMENT_COPY.accountLabel}: ${input.presentation.accountNumber} — ${input.presentation.bankName} (${input.presentation.accountName})`
    : `${PAYMENT_COPY.accountLabel}: ${input.presentation.accountNumber} (${input.presentation.accountName})`;
  const lines =
    input.leg === "DEPOSIT"
      ? [
          "💰 THANH TOÁN TIỀN ĐẶT CỌC",
          "",
          `📦 Sản phẩm: ${input.productName} · ${input.variantName}`,
          `Tiền đặt cọc: ${amount}`,
          `Còn lại khi có hàng: ${formatVnd(makeVnd(input.balanceVnd))}`,
          "",
          bankLine,
          `${PAYMENT_COPY.contentLabel}: ${input.presentation.transferContent}`,
          `${PAYMENT_COPY.expiresLabel}: ${formatExpiryVietnam(input.presentation.expiresAt)}`,
          "",
          "Suất của bạn được xác nhận ngay khi hệ thống nhận được tiền cọc.",
          PAYMENT_COPY.noScreenshot,
        ]
      : [
          "💰 THANH TOÁN PHẦN CÒN LẠI",
          "",
          `📦 Sản phẩm: ${input.productName} · ${input.variantName}`,
          `Còn phải trả: ${amount}`,
          `Tiền cọc đã trả: ${formatVnd(makeVnd(input.depositVnd))}`,
          "",
          bankLine,
          `${PAYMENT_COPY.contentLabel}: ${input.presentation.transferContent}`,
          `${PAYMENT_COPY.expiresLabel}: ${formatExpiryVietnam(input.presentation.expiresAt)}`,
          "",
          "Hàng đang được giữ riêng cho bạn. Vui lòng thanh toán trước hạn trên.",
          PAYMENT_COPY.noScreenshot,
        ];
  return {
    text: lines.join("\n"),
    photo: await toBuffer(input.presentation.payload, { type: "png", errorCorrectionLevel: "M" }),
    buttons: [
      [
        {
          text: PAYMENT_COPY.refresh,
          callbackData: `preorder:pay:${input.reservationId}`,
        },
      ],
      [{ text: "📌 Đặt cọc của tôi", callbackData: "cust:preorders" }],
      [{ text: PAYMENT_COPY.support, callbackData: "supp:open" }],
      [{ text: PAYMENT_COPY.mainMenu, callbackData: "menu:main" }],
    ],
  };
}

/** Expired intent / order (goal §37): re-mint, view the order, or get support. */ export function presentPaymentExpired(
  orderNumber: string,
): PresentedMessage {
  return {
    text: [PAYMENT_COPY.expiredTitle, "", `Đơn: ${orderNumber}`, PAYMENT_COPY.expiredBody].join(
      "\n",
    ),
    buttons: [
      [{ text: PAYMENT_COPY.reopen, callbackData: `pay:reopen:${orderNumber}` }],
      [{ text: "🧾 Xem đơn", callbackData: `ord:view:${orderNumber}` }],
      [{ text: PAYMENT_COPY.support, callbackData: `sup:open:${orderNumber}` }],
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

/**
 * Pre-payment confirmation (goal §32). Rendered BEFORE any order or payment intent exists:
 * opening the preview must not create financial state. The VietQR button carries a
 * freshly-signed Buy Now token minted here, so the confirmed price is exactly the price
 * the customer is looking at, and the proven order+intent path stays untouched.
 */
export interface CheckoutPreviewInput {
  productName: string;
  variantName: string;
  priceVnd: bigint;
  deliveryLabel: string;
  warrantyLabel: string | null;
  qrCallbackData: string;
  walletCallbackData: string;
  cancelCallbackData: string;
}

export function presentCheckoutPreview(input: CheckoutPreviewInput): PresentedMessage {
  const lines = [
    PAYMENT_COPY.previewTitle,
    "",
    `📦 Sản phẩm: ${input.productName}`,
    `🏷 Gói: ${input.variantName}`,
    `💰 Giá: ${formatVnd(makeVnd(input.priceVnd))}`,
    `⚡ Giao hàng: ${input.deliveryLabel}`,
  ];
  if (input.warrantyLabel) lines.push(`🛡 Bảo hành: ${input.warrantyLabel}`);
  lines.push("", "Chọn cách thanh toán:");
  return {
    text: lines.join("\n"),
    buttons: [
      [{ text: "🏦 VietQR", callbackData: input.qrCallbackData }],
      [{ text: "👛 Ví TIER20", callbackData: input.walletCallbackData }],
      [{ text: "❌ Huỷ", callbackData: input.cancelCallbackData }],
    ],
  };
}

/** Wallet shortfall (goal §42): show balance, price and the exact missing amount. */
export function presentInsufficientBalance(input: {
  balanceVnd: bigint;
  priceVnd: bigint;
  shortfallVnd: bigint;
  topUpCallbackData: string;
  qrCallbackData: string;
  cancelCallbackData: string;
}): PresentedMessage {
  return {
    text: [
      "⚠️ SỐ DƯ VÍ KHÔNG ĐỦ",
      "",
      `💰 Số dư: ${formatVnd(makeVnd(input.balanceVnd))}`,
      `🏷 Giá: ${formatVnd(makeVnd(input.priceVnd))}`,
      `➖ Còn thiếu: ${formatVnd(makeVnd(input.shortfallVnd))}`,
    ].join("\n"),
    buttons: [
      [
        {
          text: `⚡ Nạp thêm ${formatVnd(makeVnd(input.shortfallVnd))}`,
          callbackData: input.topUpCallbackData,
        },
      ],
      [{ text: "🏦 Thanh toán VietQR", callbackData: input.qrCallbackData }],
      [{ text: "❌ Huỷ", callbackData: input.cancelCallbackData }],
    ],
  };
}

export interface WalletHistoryEntry {
  entryType: string;
  amountVnd: bigint;
  balanceAfterVnd: bigint;
  reason: string;
  createdAt: Date;
}

/** Friendly word per ledger entry type; an unknown internal type stays neutral. */
function walletEntryLabel(entryType: string): string {
  const kind = entryType.toUpperCase();
  if (kind.includes("REFUND")) return "Hoàn tiền";
  if (kind.includes("TOPUP") || kind === "CREDIT") return "Nạp ví";
  if (kind.includes("PURCHASE") || kind === "DEBIT") return "Thanh toán đơn";
  return "Giao dịch ví";
}

function isWalletCredit(entryType: string): boolean {
  const kind = entryType.toUpperCase();
  return kind.includes("REFUND") || kind.includes("TOPUP") || kind === "CREDIT";
}

/**
 * Wallet ledger history (goal §38): balance, then one line per entry with a friendly
 * label, a signed amount and the resulting balance. The raw entry enum is never shown.
 */
export function presentWalletHistory(input: {
  balanceVnd: bigint;
  entries: readonly WalletHistoryEntry[];
}): PresentedMessage {
  const lines = ["📜 LỊCH SỬ VÍ", "", `Số dư: ${formatVnd(makeVnd(input.balanceVnd))}`];
  if (input.entries.length === 0) {
    lines.push("", "Chưa có giao dịch nào.");
  } else {
    lines.push("");
    for (const entry of input.entries) {
      const sign = isWalletCredit(entry.entryType) ? "+" : "-";
      lines.push(
        `${formatVietnamDateTime(entry.createdAt)} · ${walletEntryLabel(entry.entryType)} · ${sign}${formatVnd(makeVnd(entry.amountVnd))} · Số dư sau: ${formatVnd(makeVnd(entry.balanceAfterVnd))}`,
      );
    }
  }
  return {
    text: lines.join("\n"),
    buttons: [[{ text: "🏠 Trang chủ", callbackData: "shop:home" }]],
  };
}
