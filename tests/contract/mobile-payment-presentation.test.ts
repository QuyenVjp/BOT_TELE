import { describe, expect, it } from "vitest";
import {
  PAYMENT_COPY,
  QR_RENDER_TIMEOUT_MS,
  QR_RENDER_WIDTH_PX,
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  buildMobilePaymentKeyboard,
  buildPaymentCaption,
  paymentCopyPayloads,
  presentPaymentCancelled,
  presentPaymentExpired,
  presentPaymentNeedsReview,
  presentPaymentScreen,
  presentPaymentSettled,
} from "../../src/bot/presenters/payment.js";
import {
  DEFAULT_MOBILE_BANK_TRANSFER,
  TELEGRAM_COPY_TEXT_LIMIT,
  parsePaymentPresentationOverride,
  resolvePaymentPresentationProfile,
  sanitizeCopyText,
} from "../../src/bot/presenters/payment-presentation-profile.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";

const PRESENTATION: PaymentPresentation = {
  payload: "00020101021238540010A0000007270124compact-payload6304ABCD",
  bankBin: "970422",
  accountNumber: "0123456789",
  accountName: "TIER20 SHOP",
  amountVnd: 199000,
  transferContent: "ORDABC123456",
  orderNumber: "ORD-20260913-A1B2C3D4",
  expiresAt: "2026-07-16T12:15:00.000Z",
  bankName: "MB Bank",
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const SECRETISH_RE = /vault:|sk_live|hmac|secret/i;

function pngWidth(buffer: Buffer): number {
  return buffer.readUInt32BE(16);
}

function copyValues(message: { buttons: Array<Array<{ text: string; copyText?: string }>> }) {
  return message.buttons
    .flat()
    .filter((button) => button.copyText)
    .map((button) => ({ text: button.text, copyText: button.copyText }));
}

describe("mobile payment presentation profiles", () => {
  it("uses the default mobile bank-transfer profile for most products", () => {
    const profile = resolvePaymentPresentationProfile({});
    expect(profile).toMatchObject({
      profileId: DEFAULT_MOBILE_BANK_TRANSFER.profileId,
      showAccountCopyButton: true,
      showAmountCopyButton: true,
      showTransferContentCopyButton: true,
      showPaymentCheckButton: true,
      showCancelButton: true,
    });
  });

  it("adds a STOCK_CODE delivery note without changing payment truth", () => {
    const profile = resolvePaymentPresentationProfile({ fulfillmentType: "STOCK_CODE" });
    expect(profile.profileId).toBe("STOCK_CODE");
    expect(profile.fulfillmentNotice).toContain("mã hàng được giao tự động");
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showPaymentCheckButton).toBe(true);
  });

  it("accepts a small typed product override and ignores payment-truth fields", () => {
    const parsed = parsePaymentPresentationOverride({
      headline: "Thanh toán gói VIP",
      extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
      qrTemplate: "qronly",
      showBankHolder: false,
      amountVnd: 1,
      accountNumber: "hack",
      showPaymentCheckButton: false,
      showCancelButton: false,
    });
    expect(parsed).toBeUndefined();

    const safe = parsePaymentPresentationOverride({
      headline: "Thanh toán gói VIP",
      extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
      qrTemplate: "qronly",
      showBankHolder: false,
    });
    expect(safe).toEqual({
      headline: "Thanh toán gói VIP",
      extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
      qrTemplate: "qronly",
      showBankHolder: false,
    });

    const profile = resolvePaymentPresentationProfile({
      fulfillmentType: "STOCK_CODE",
      override: safe,
    });
    expect(profile.headline).toBe("Thanh toán gói VIP");
    expect(profile.qrTemplate).toBe("qronly");
    expect(profile.showBankHolder).toBe(false);
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showAmountCopyButton).toBe(true);
    expect(profile.showTransferContentCopyButton).toBe(true);
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
    expect(profile.fulfillmentNotice).toContain("mã hàng được giao tự động");
  });

  it("does not let a product override hide one-phone copy buttons", () => {
    const profile = resolvePaymentPresentationProfile({
      override: {
        showAccountCopyButton: false,
        showAmountCopyButton: false,
        showTransferContentCopyButton: false,
      },
    });
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showAmountCopyButton).toBe(true);
    expect(profile.showTransferContentCopyButton).toBe(true);
  });
});

describe("pending mobile payment screen", () => {
  it("renders a large QR plus authoritative bank facts and native copy buttons", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      status: "PENDING",
      productName: "Netflix Premium",
      variantName: "1 tháng",
      fulfillmentType: "STOCK_ACCOUNT",
    });

    expect(msg.photo).toBeInstanceOf(Buffer);
    expect(pngWidth(msg.photo as Buffer)).toBe(QR_RENDER_WIDTH_PX);
    expect(msg.text).toContain("💳 Thanh toán đơn #ORD-20260913-A1B2C3D4");
    expect(msg.text).toContain("📦 Netflix Premium · 1 tháng");
    expect(msg.text).toContain("199.000");
    expect(msg.text).toContain("MB Bank");
    expect(msg.text).toContain("TIER20 SHOP");
    expect(msg.text).toContain("0123456789");
    expect(msg.text).toContain("ORDABC123456");
    expect(msg.text).toContain("19:15");
    expect(msg.text).toMatch(/GMT\+7/);
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
    expect(msg.text).not.toMatch(UUID_RE);
    expect(msg.text).not.toMatch(SECRETISH_RE);

    const copies = copyValues(msg);
    expect(copies).toEqual(
      expect.arrayContaining([
        { text: PAYMENT_COPY.copyAccount, copyText: "0123456789" },
        { text: PAYMENT_COPY.copyContent, copyText: "ORDABC123456" },
        { text: PAYMENT_COPY.copyAmount, copyText: "199000" },
        { text: PAYMENT_COPY.copyOrder, copyText: PRESENTATION.orderNumber },
      ]),
    );
    expect(
      copies.every((button) => (button.copyText ?? "").length <= TELEGRAM_COPY_TEXT_LIMIT),
    ).toBe(true);

    const labels = msg.buttons.flat().map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining([
        PAYMENT_COPY.copyAccount,
        PAYMENT_COPY.copyContent,
        PAYMENT_COPY.copyAmount,
        PAYMENT_COPY.copyOrder,
        PAYMENT_COPY.refresh,
        PAYMENT_COPY.cancel,
      ]),
    );
    const data = msg.buttons.flat().map((button) => button.callbackData);
    expect(data).toContain(`pay:refresh:${PRESENTATION.orderNumber}`);
    expect(data).toContain(`pay:cancel:${PRESENTATION.orderNumber}`);
  });

  it("keeps the caption within Telegram's photo limit", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      productName: "X".repeat(400),
      variantName: "Y".repeat(400),
      fulfillmentType: "MANUAL_FULFILLMENT",
      profileOverride: {
        extraNotice: "N".repeat(160),
      },
    });
    expect(msg.text.length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LIMIT);
  });

  it("lets the same-phone customer copy STK, amount, and transfer content without a QR", async () => {
    const payloads = paymentCopyPayloads(PRESENTATION);
    expect(payloads).toEqual({
      account: "0123456789",
      transferContent: "ORDABC123456",
      amountDigits: "199000",
      orderNumber: PRESENTATION.orderNumber,
    });
    const profile = resolvePaymentPresentationProfile({});
    const keyboard = buildMobilePaymentKeyboard({
      presentation: PRESENTATION,
      profile,
      refreshCallbackData: "pay:refresh:ORD",
      cancelCallbackData: "pay:cancel:ORD",
    });
    const copies = keyboard.flat().filter((button) => button.copyText);
    expect(copies.map((button) => button.copyText).sort()).toEqual(
      ["0123456789", "199000", "ORDABC123456", PRESENTATION.orderNumber].sort(),
    );
  });
});

describe("payment lifecycle screens", () => {
  it("PENDING stays unpaid and copyable", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, { status: "PENDING" });
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
    expect(copyValues(msg).length).toBeGreaterThanOrEqual(3);
  });

  it("CHECK_PENDING explains the wait without claiming settlement", async () => {
    const caption = buildPaymentCaption(
      PRESENTATION,
      { status: "CHECK_PENDING" },
      resolvePaymentPresentationProfile({}),
    );
    expect(caption).toContain(PAYMENT_COPY.checkPending);
    expect(caption.toLowerCase()).not.toContain("đã thanh toán");
  });

  it("PAID confirms settlement from evidence, not from the QR", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, { status: "PAID" });
    expect(msg.text).toContain(PAYMENT_COPY.settledTitle);
    expect(msg.text).toContain(PRESENTATION.orderNumber);
    expect(msg.photo).toBeUndefined();
    expect(copyValues(msg)).toEqual([]);
  });

  it("EXPIRED offers reopen and no screenshot instruction", () => {
    const msg = presentPaymentExpired(PRESENTATION.orderNumber);
    expect(msg.text).toContain(PAYMENT_COPY.expiredTitle);
    expect(msg.buttons.flat().map((button) => button.callbackData)).toContain(
      `pay:reopen:${PRESENTATION.orderNumber}`,
    );
  });

  it("CANCELLED invalidates old payment buttons", () => {
    const msg = presentPaymentCancelled(PRESENTATION.orderNumber);
    expect(msg.text).toContain(PRESENTATION.orderNumber);
    expect(msg.text.toLowerCase()).toMatch(/huỷ|hủy/);
  });

  it("needs-review shows a friendly reference, not an internal UUID", () => {
    const msg = presentPaymentNeedsReview(PRESENTATION.orderNumber, PRESENTATION.orderNumber);
    expect(msg.text).toContain(PRESENTATION.orderNumber);
    expect(msg.text).not.toMatch(UUID_RE);
    expect(msg.buttons.flat().some((button) => button.callbackData.startsWith("sup:"))).toBe(true);
    const settled = presentPaymentSettled(PRESENTATION.orderNumber);
    expect(settled.text).toContain(PRESENTATION.orderNumber);
  });
});

describe("QR failure fallback", () => {
  it("falls back to text plus copy buttons when QR rendering fails", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      qrRenderer: async () => {
        throw new Error("QR_FETCH_FAILED");
      },
    });
    expect(msg.photo).toBeUndefined();
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
    expect(copyValues(msg).map((button) => button.copyText)).toEqual(
      expect.arrayContaining(["0123456789", "ORDABC123456", "199000"]),
    );
  });

  it("falls back when QR rendering times out", async () => {
    const started = Date.now();
    const msg = await presentPaymentScreen(PRESENTATION, {
      qrRenderer: () => new Promise(() => undefined),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(QR_RENDER_TIMEOUT_MS - 50);
    expect(msg.photo).toBeUndefined();
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
    expect(copyValues(msg).length).toBeGreaterThanOrEqual(3);
  }, 8_000);
});

describe("copy_text sanitization", () => {
  it("truncates to Telegram copy_text limit without splitting a code point", () => {
    const value = `${"A".repeat(255)}😀 extra`;
    const sanitized = sanitizeCopyText(value);
    expect([...sanitized].length).toBeLessThanOrEqual(TELEGRAM_COPY_TEXT_LIMIT);
    expect(sanitized.includes("\uFFFD")).toBe(false);
  });
});
