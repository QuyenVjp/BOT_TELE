import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { toBuffer } from "qrcode";
import type { FulfillmentType } from "../../modules/catalog/fulfillment-type.js";
import type { PaymentPresentation } from "../../modules/payments/vietqr.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";
import {
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  resolvePaymentPresentationProfile,
  sanitizeCopyText,
  type PaymentPresentationProfile,
} from "./payment-presentation-profile.js";

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
  instruction: "Quét QR, hoặc sao chép STK / số tiền / nội dung để chuyển trên điện thoại này.",
  qrFallback:
    "Không hiển thị được QR. Dùng nút sao chép STK / số tiền / nội dung bên dưới để chuyển trên điện thoại này.",
  refresh: "✅ Kiểm tra thanh toán",
  cancel: "❌ Huỷ đơn",
  reopen: "🛒 Tạo lại thanh toán",
  support: "💬 Hỗ trợ",
  mainMenu: "🏠 Menu",
  copyAccount: "📋 Sao chép STK",
  copyContent: "📋 Nội dung CK",
  copyAmount: "📋 Số tiền",
  copyOrder: "📋 Mã đơn",
  checkPending: "⏳ Chưa nhận được thanh toán.",
  checkPendingHint: "Hệ thống sẽ tự cập nhật ngay khi ngân hàng xác nhận.",
  expiredTitle: "⌛ Yêu cầu thanh toán đã hết hạn.",
  expiredBody:
    "Đơn hàng đã quá thời gian chờ thanh toán. Bạn có thể tạo lại thanh toán hoặc xem đơn.",
  settledTitle: "✅ Đã thanh toán",
  settledBody: "Đơn hàng đã được xác nhận thanh toán. Chúng tôi sẽ giao tài khoản ngay.",
  reviewTitle: "🔎 Đang kiểm tra giao dịch",
  reviewBody:
    "Giao dịch cần đối soát thủ công. Vui lòng chờ hoặc liên hệ hỗ trợ với mã tham chiếu bên dưới. Không gửi ảnh biên lai.",
  cancelledTitle: "❌ Đơn đã huỷ.",
} as const;

export type PaymentScreenStatus = "PENDING" | "CHECK_PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

export interface PaymentScreenContext {
  status?: PaymentScreenStatus;
  productName?: string;
  variantName?: string;
  quantity?: number;
  fulfillmentType?: FulfillmentType;
  /** Untrusted product metadata; sanitized by the profile schema. */
  profileOverride?: unknown;
  /** Trusted caller patch (wallet / checkout). May hide check/cancel. */
  profilePatch?: Partial<PaymentPresentationProfile>;
  /** Injectable QR renderer for tests. */
  qrRenderer?: (payload: string) => Promise<Buffer>;
}

export interface PaymentCopyPayloads {
  account: string;
  transferContent: string;
  amountDigits: string;
  orderNumber: string;
}

export { TELEGRAM_PHOTO_CAPTION_LIMIT };
export const QR_RENDER_TIMEOUT_MS = 1_500;
export const QR_RENDER_WIDTH_PX = 512;

function styledButton(
  text: string,
  callbackData: string,
  style?: InlineButton["style"],
): InlineButton {
  return style ? { text, callbackData, style } : { text, callbackData };
}

function copyButton(text: string, value: string): InlineButton {
  return { text, callbackData: "", copyText: value, style: "primary" };
}

function navButtons(orderNumber: string): InlineButton[][] {
  return [
    [styledButton(PAYMENT_COPY.mainMenu, "menu:main")],
    [styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`)],
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

export function paymentCopyPayloads(presentation: PaymentPresentation): PaymentCopyPayloads {
  return {
    account: sanitizeCopyText(presentation.accountNumber),
    transferContent: sanitizeCopyText(presentation.transferContent),
    amountDigits: sanitizeCopyText(String(presentation.amountVnd)),
    orderNumber: sanitizeCopyText(presentation.orderNumber),
  };
}

function pairRows(buttons: InlineButton[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}

export function buildMobilePaymentKeyboard(input: {
  presentation: PaymentPresentation;
  profile: PaymentPresentationProfile;
  refreshCallbackData?: string;
  cancelCallbackData?: string;
  extraRows?: InlineButton[][];
}): InlineButton[][] {
  const payloads = paymentCopyPayloads(input.presentation);
  const copies: InlineButton[] = [];
  if (input.profile.showAccountCopyButton && payloads.account) {
    copies.push(copyButton(PAYMENT_COPY.copyAccount, payloads.account));
  }
  if (input.profile.showTransferContentCopyButton && payloads.transferContent) {
    copies.push(copyButton(PAYMENT_COPY.copyContent, payloads.transferContent));
  }
  if (input.profile.showAmountCopyButton && payloads.amountDigits) {
    copies.push(copyButton(PAYMENT_COPY.copyAmount, payloads.amountDigits));
  }
  if (
    input.profile.showOrderCode &&
    input.profile.showOrderCodeCopyButton &&
    payloads.orderNumber
  ) {
    copies.push(copyButton(PAYMENT_COPY.copyOrder, payloads.orderNumber));
  }
  const rows = pairRows(copies);
  if (input.profile.showPaymentCheckButton && input.refreshCallbackData) {
    rows.push([styledButton(PAYMENT_COPY.refresh, input.refreshCallbackData, "success")]);
  }
  const actionRow: InlineButton[] = [];
  if (input.profile.showCancelButton && input.cancelCallbackData) {
    actionRow.push(styledButton(PAYMENT_COPY.cancel, input.cancelCallbackData, "danger"));
  }
  actionRow.push(styledButton(PAYMENT_COPY.mainMenu, "menu:main"));
  if (actionRow.length > 0) rows.push(actionRow);
  if (input.extraRows) rows.push(...input.extraRows);
  return rows;
}

function productLine(
  context: PaymentScreenContext,
  profile: PaymentPresentationProfile,
): string | null {
  if (!profile.showProductDetails) return null;
  const product = context.productName?.trim();
  const variant = context.variantName?.trim();
  if (!product && !variant) return null;
  const name = [product, variant].filter(Boolean).join(" · ");
  if (profile.showQuantity && context.quantity && context.quantity > 1) {
    return `📦 ${name} × ${context.quantity}`;
  }
  return `📦 ${name}`;
}

function trimCaption(lines: string[], droppable: ReadonlySet<string>): string {
  let next = lines.filter((line) => line !== undefined);
  let text = next.join("\n");
  while (text.length > TELEGRAM_PHOTO_CAPTION_LIMIT) {
    const idx = next.findIndex((line) => droppable.has(line) && line.length > 0);
    if (idx < 0) break;
    next = next.filter((_, i) => i !== idx);
    text = next.join("\n");
  }
  if (text.length > TELEGRAM_PHOTO_CAPTION_LIMIT) {
    text = [...text].slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT).join("");
  }
  return text;
}

export function buildPaymentCaption(
  presentation: PaymentPresentation,
  context: PaymentScreenContext,
  profile: PaymentPresentationProfile,
): string {
  const amount = formatVnd(makeVnd(presentation.amountVnd));
  const headline = profile.headline ?? `💳 Thanh toán đơn #${presentation.orderNumber}`;
  const product = productLine(context, profile);
  const extra = profile.extraNotice;
  const fulfillment = profile.fulfillmentNotice;
  const lines: string[] = [];
  if (context.status === "CHECK_PENDING") {
    lines.push(PAYMENT_COPY.checkPending, PAYMENT_COPY.checkPendingHint, "");
  }
  lines.push(headline);
  if (product) lines.push(product);
  lines.push(`💰 Tổng: ${amount}`);
  if (presentation.bankName) lines.push(`🏦 Ngân hàng: ${presentation.bankName}`);
  if (profile.showBankHolder) lines.push(`👤 Thụ hưởng: ${presentation.accountName}`);
  lines.push(`💳 STK: ${presentation.accountNumber}`);
  lines.push(`📝 ${PAYMENT_COPY.contentLabel}: ${presentation.transferContent}`);
  lines.push(`⏱️ ${PAYMENT_COPY.expiresLabel}: ${formatExpiryVietnam(presentation.expiresAt)}`);
  lines.push("", PAYMENT_COPY.instruction, PAYMENT_COPY.noScreenshot);
  if (fulfillment) lines.push("", fulfillment);
  if (extra) lines.push(extra);

  const droppable = new Set<string>([extra ?? "", fulfillment ?? "", product ?? ""]);
  return trimCaption(lines, droppable);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("QR_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function renderPaymentQrPng(
  payload: string,
  renderer?: (payload: string) => Promise<Buffer>,
): Promise<Buffer | undefined> {
  try {
    const rendered = renderer
      ? renderer(payload)
      : toBuffer(payload, {
          type: "png",
          errorCorrectionLevel: "M",
          margin: 4,
          width: QR_RENDER_WIDTH_PX,
          color: { dark: "#000000", light: "#ffffff" },
        });
    const buffer = await withTimeout(rendered, QR_RENDER_TIMEOUT_MS);
    return buffer.length > 0 ? buffer : undefined;
  } catch {
    return undefined;
  }
}

function resolveProfile(context: PaymentScreenContext): PaymentPresentationProfile {
  return resolvePaymentPresentationProfile({
    ...(context.fulfillmentType ? { fulfillmentType: context.fulfillmentType } : {}),
    ...(context.profileOverride !== undefined ? { override: context.profileOverride } : {}),
    ...(context.profilePatch ? { patch: context.profilePatch } : {}),
  });
}

/**
 * Payment screen after Buy Now / reopen. Shows exact amount/content/expiry +
 * the no-screenshot line. Callbacks bind to the order number so the checkout
 * layer can re-resolve the live intent without smuggling state in the message.
 */
export async function presentPaymentScreen(
  presentation: PaymentPresentation,
  context: PaymentScreenContext = {},
): Promise<PresentedMessage> {
  const status = context.status ?? "PENDING";
  if (status === "PAID") return presentPaymentSettled(presentation.orderNumber);
  if (status === "EXPIRED") return presentPaymentExpired(presentation.orderNumber);
  if (status === "CANCELLED") return presentPaymentCancelled(presentation.orderNumber);

  const profile = resolveProfile(context);
  const photo = await renderPaymentQrPng(presentation.payload, context.qrRenderer);
  let text = buildPaymentCaption(presentation, { ...context, status }, profile);
  if (!photo) {
    const fallbackLine = PAYMENT_COPY.qrFallback;
    const withFallback = `${text}\n\n${fallbackLine}`;
    text =
      withFallback.length <= TELEGRAM_PHOTO_CAPTION_LIMIT
        ? withFallback
        : trimCaption(
            [...text.split("\n"), "", fallbackLine],
            new Set([PAYMENT_COPY.instruction, productLine(context, profile) ?? ""]),
          );
  }
  const message: PresentedMessage = {
    text,
    buttons: buildMobilePaymentKeyboard({
      presentation,
      profile,
      refreshCallbackData: `pay:refresh:${presentation.orderNumber}`,
      cancelCallbackData: `pay:cancel:${presentation.orderNumber}`,
    }),
  };
  if (photo) message.photo = photo;
  return message;
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
  qrRenderer?: (payload: string) => Promise<Buffer>;
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
  const profile = resolvePaymentPresentationProfile({
    patch: { showPaymentCheckButton: true, showCancelButton: false },
  });
  const photo = await renderPaymentQrPng(input.presentation.payload, input.qrRenderer);
  let caption = lines.join("\n");
  if (!photo) {
    const withFallback = `${caption}\n\n${PAYMENT_COPY.qrFallback}`;
    caption = withFallback.length <= TELEGRAM_PHOTO_CAPTION_LIMIT ? withFallback : caption;
  }
  const message: PresentedMessage = {
    text: caption,
    buttons: buildMobilePaymentKeyboard({
      presentation: input.presentation,
      profile,
      refreshCallbackData: `preorder:pay:${input.reservationId}`,
      extraRows: [
        [{ text: "📌 Đặt cọc của tôi", callbackData: "cust:preorders" }],
        [{ text: PAYMENT_COPY.support, callbackData: "supp:open" }],
      ],
    }),
  };
  if (photo) message.photo = photo;
  return message;
}

/** Expired intent / order (goal §37): re-mint, view the order, or get support. */
export function presentPaymentExpired(orderNumber: string): PresentedMessage {
  return {
    text: [PAYMENT_COPY.expiredTitle, "", `Đơn: ${orderNumber}`, PAYMENT_COPY.expiredBody].join(
      "\n",
    ),
    buttons: [
      [styledButton(PAYMENT_COPY.reopen, `pay:reopen:${orderNumber}`)],
      [{ text: "🧾 Xem đơn", callbackData: `ord:view:${orderNumber}` }],
      [styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`)],
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
      [styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`)],
      [styledButton(PAYMENT_COPY.mainMenu, "menu:main")],
    ],
  };
}

export function presentPaymentCancelled(orderNumber: string): PresentedMessage {
  return {
    text: [
      `❌ Đơn ${orderNumber} đã huỷ.`,
      "",
      "Các nút thanh toán trên tin nhắn cũ không còn hiệu lực.",
    ].join("\n"),
    buttons: [[styledButton(PAYMENT_COPY.mainMenu, "menu:main")]],
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
