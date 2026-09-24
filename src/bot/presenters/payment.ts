import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { toBuffer } from "qrcode";
import type { FulfillmentType } from "../../modules/catalog/fulfillment-type.js";
import type { PaymentPresentation } from "../../modules/payments/vietqr.js";
import type { InlineButton, PresentedMessage } from "./catalog.js";
import {
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  exactCopyText,
  resolvePaymentPresentationProfile,
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
  previewTitle: "🛒 Xác nhận mua hàng",
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
  reminder: "🔔 Nhắc thanh toán",
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
  account: string | undefined;
  transferContent: string | undefined;
  amountDigits: string | undefined;
  orderNumber: string | undefined;
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
    [
      styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`),
      styledButton(PAYMENT_COPY.mainMenu, "menu:main"),
    ],
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
    account: exactCopyText(presentation.accountNumber),
    transferContent: exactCopyText(presentation.transferContent),
    amountDigits: exactCopyText(String(presentation.amountVnd)),
    orderNumber: exactCopyText(presentation.orderNumber),
  };
}

export function buildMobilePaymentKeyboard(input: {
  presentation: PaymentPresentation;
  profile: PaymentPresentationProfile;
  refreshCallbackData?: string;
  cancelCallbackData?: string;
  reminderCallbackData?: string;
  extraRows?: InlineButton[][];
}): InlineButton[][] {
  const payloads = paymentCopyPayloads(input.presentation);
  const { profile } = input;
  // FIXED slots: a hidden copy button leaves a gap, it never reshuffles its neighbours.
  const rows: InlineButton[][] = [];
  const bankRow = [
    profile.showAccountCopyButton && payloads.account
      ? copyButton(PAYMENT_COPY.copyAccount, payloads.account)
      : null,
    profile.showTransferContentCopyButton && payloads.transferContent
      ? copyButton(PAYMENT_COPY.copyContent, payloads.transferContent)
      : null,
  ].filter((button) => button !== null);
  if (bankRow.length > 0) rows.push(bankRow);
  const valueRow = [
    profile.showAmountCopyButton && payloads.amountDigits
      ? copyButton(PAYMENT_COPY.copyAmount, payloads.amountDigits)
      : null,
    profile.showOrderCode && profile.showOrderCodeCopyButton && payloads.orderNumber
      ? copyButton(PAYMENT_COPY.copyOrder, payloads.orderNumber)
      : null,
  ].filter((button) => button !== null);
  if (valueRow.length > 0) rows.push(valueRow);
  if (profile.showPaymentCheckButton && input.refreshCallbackData) {
    rows.push([styledButton(PAYMENT_COPY.refresh, input.refreshCallbackData, "success")]);
  }
  if (profile.showCancelButton && input.cancelCallbackData) {
    rows.push([styledButton(PAYMENT_COPY.cancel, input.cancelCallbackData, "danger")]);
  }
  if (input.reminderCallbackData) {
    rows.push([styledButton(PAYMENT_COPY.reminder, input.reminderCallbackData)]);
  }
  rows.push([styledButton(PAYMENT_COPY.mainMenu, "menu:main")]);
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

/**
 * One addressable chunk of the payment caption. `dropRank` is the order in which the
 * block is sacrificed when the caption overflows (1 goes first); `null` marks a field the
 * customer MUST always see (headline/order, amount, bank, holder, STK, content, expiry).
 */
interface CaptionBlock {
  readonly lines: readonly string[];
  readonly dropRank: number | null;
}

/** Drop priorities, lowest sacrificed first (K7). */
const DROP_EXTRA_NOTICE = 1;
const DROP_FULFILLMENT_NOTICE = 2;
const DROP_INSTRUCTION = 3;
const DROP_NO_SCREENSHOT = 4;
const DROP_PRODUCT_LINE = 5;

function joinCaptionBlocks(blocks: readonly CaptionBlock[]): string {
  return blocks.map((block) => block.lines.join("\n")).join("\n");
}

/**
 * Render the ordered blocks within Telegram's photo-caption budget: sacrifice blocks by
 * ascending drop rank until it fits, then truncate by CODE POINT as the last resort so a
 * surrogate pair is never split into a replacement character.
 */
function renderCaption(blocks: readonly CaptionBlock[]): string {
  let kept = blocks.filter((block) => block.lines.length > 0);
  let text = joinCaptionBlocks(kept);
  while ([...text].length > TELEGRAM_PHOTO_CAPTION_LIMIT) {
    let victim = -1;
    let victimRank = Number.POSITIVE_INFINITY;
    kept.forEach((block, index) => {
      if (block.dropRank !== null && block.dropRank < victimRank) {
        victimRank = block.dropRank;
        victim = index;
      }
    });
    if (victim < 0) break;
    kept = kept.filter((_, index) => index !== victim);
    text = joinCaptionBlocks(kept);
  }
  return [...text].length > TELEGRAM_PHOTO_CAPTION_LIMIT
    ? [...text].slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT).join("")
    : text;
}

/** Caption blocks in render order, each with the rank at which it may be dropped. */
function paymentCaptionBlocks(
  presentation: PaymentPresentation,
  context: PaymentScreenContext,
  profile: PaymentPresentationProfile,
): CaptionBlock[] {
  const amount = formatVnd(makeVnd(presentation.amountVnd));
  const headline = profile.headline ?? `💳 Thanh toán đơn #${presentation.orderNumber}`;
  const product = productLine(context, profile);
  const blocks: CaptionBlock[] = [];
  if (context.status === "CHECK_PENDING") {
    blocks.push({
      lines: [PAYMENT_COPY.checkPending, PAYMENT_COPY.checkPendingHint, ""],
      dropRank: null,
    });
  }
  blocks.push({ lines: [headline], dropRank: null });
  if (product) blocks.push({ lines: [product], dropRank: DROP_PRODUCT_LINE });
  blocks.push({ lines: [`💰 Tổng: ${amount}`], dropRank: null });
  if (presentation.bankName)
    blocks.push({ lines: [`🏦 Ngân hàng: ${presentation.bankName}`], dropRank: null });
  if (profile.showBankHolder) {
    blocks.push({ lines: [`👤 Thụ hưởng: ${presentation.accountName}`], dropRank: null });
  }
  blocks.push({ lines: [`💳 STK: ${presentation.accountNumber}`], dropRank: null });
  blocks.push({
    lines: [`📝 ${PAYMENT_COPY.contentLabel}: ${presentation.transferContent}`],
    dropRank: null,
  });
  blocks.push({
    lines: [`⏱️ ${PAYMENT_COPY.expiresLabel}: ${formatExpiryVietnam(presentation.expiresAt)}`],
    dropRank: null,
  });
  blocks.push({ lines: ["", PAYMENT_COPY.instruction], dropRank: DROP_INSTRUCTION });
  blocks.push({ lines: [PAYMENT_COPY.noScreenshot], dropRank: DROP_NO_SCREENSHOT });
  if (profile.fulfillmentNotice) {
    blocks.push({
      lines: ["", profile.fulfillmentNotice],
      dropRank: DROP_FULFILLMENT_NOTICE,
    });
  }
  if (profile.extraNotice) {
    blocks.push({ lines: [profile.extraNotice], dropRank: DROP_EXTRA_NOTICE });
  }
  return blocks;
}

export function buildPaymentCaption(
  presentation: PaymentPresentation,
  context: PaymentScreenContext,
  profile: PaymentPresentationProfile,
): string {
  return renderCaption(paymentCaptionBlocks(presentation, context, profile));
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
  const blocks = paymentCaptionBlocks(presentation, { ...context, status }, profile);
  // No QR: the copy instruction is what carries the customer, so it outranks the product
  // name when the caption has to give something up (K7 does not rank this line).
  if (!photo) {
    blocks.push({ lines: ["", PAYMENT_COPY.qrFallback], dropRank: DROP_PRODUCT_LINE });
  }
  const message: PresentedMessage = {
    text: renderCaption(blocks),
    buttons: buildMobilePaymentKeyboard({
      presentation,
      profile,
      refreshCallbackData: `pay:refresh:${presentation.orderNumber}`,
      reminderCallbackData: `pay:remind:${presentation.orderNumber}`,
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
          "💰 Thanh toán tiền đặt cọc",
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
          "💰 Thanh toán phần còn lại",
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
        [
          { text: "📌 Đặt cọc của tôi", callbackData: "cust:preorders" },
          { text: PAYMENT_COPY.support, callbackData: "supp:open" },
        ],
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
      [
        { text: "🧾 Xem đơn", callbackData: `ord:view:${orderNumber}` },
        styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`),
      ],
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
      [
        styledButton(PAYMENT_COPY.support, `sup:open:${orderNumber}`),
        styledButton(PAYMENT_COPY.mainMenu, "menu:main"),
      ],
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
export function presentPaymentReminderCooldown(orderNumber: string): PresentedMessage {
  return {
    text: `🔔 Đã nhắc thanh toán cho đơn ${orderNumber} gần đây. Vui lòng kiểm tra tin nhắn thanh toán hiện tại.`,
    buttons: [
      [
        styledButton(PAYMENT_COPY.refresh, `pay:refresh:${orderNumber}`),
        styledButton(PAYMENT_COPY.mainMenu, "menu:main"),
      ],
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
  lines.push("", "Thanh toán bằng VietQR:");
  return {
    text: lines.join("\n"),
    buttons: [
      [{ text: "🏦 VietQR", callbackData: input.qrCallbackData }],
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
      "⚠️ Số dư ví không đủ",
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
  const lines = ["📜 Lịch sử ví", "", `Số dư: ${formatVnd(makeVnd(input.balanceVnd))}`];
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
