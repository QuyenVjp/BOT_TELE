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
  TELEGRAM_COPY_TEXT_LIMIT,
  parsePaymentPresentationOverride,
  resolvePaymentPresentationProfile,
  sanitizeCopyText,
} from "../../src/bot/presenters/payment-presentation-profile.js";
import { buildVietQrPayload, presentPayment } from "../../src/modules/payments/vietqr.js";
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

const QR_BYTES = Buffer.from("qr-png");
const silentQr = { qrRenderer: async () => QR_BYTES };

function pngWidth(buffer: Buffer): number {
  return buffer.readUInt32BE(16);
}

function pngHeight(buffer: Buffer): number {
  return buffer.readUInt32BE(20);
}

function copyValues(message: { buttons: Array<Array<{ text: string; copyText?: string }>> }) {
  return message.buttons
    .flat()
    .filter((button) => button.copyText)
    .map((button) => ({ text: button.text, copyText: button.copyText }));
}

function labels(message: { buttons: Array<Array<{ text: string }>> }): string[] {
  return message.buttons.flat().map((button) => button.text);
}

describe("mobile payment presentation profiles", () => {
  it("uses the default mobile bank-transfer profile for most products", () => {
    const profile = resolvePaymentPresentationProfile({});
    expect(profile).toMatchObject({
      showAccountCopyButton: true,
      showAmountCopyButton: true,
      showTransferContentCopyButton: true,
      showPaymentCheckButton: true,
      showCancelButton: true,
    });
  });

  it("adds a STOCK_CODE delivery note without changing payment truth", () => {
    const profile = resolvePaymentPresentationProfile({ fulfillmentType: "STOCK_CODE" });
    expect(profile.fulfillmentNotice).toContain("mã hàng được giao tự động");
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showPaymentCheckButton).toBe(true);
  });

  it("accepts a small typed product override and ignores payment-truth fields", () => {
    const parsed = parsePaymentPresentationOverride({
      headline: "Thanh toán gói VIP",
      extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
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
      showBankHolder: false,
    });
    expect(safe).toEqual({
      headline: "Thanh toán gói VIP",
      extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
      showBankHolder: false,
    });

    const profile = resolvePaymentPresentationProfile({
      fulfillmentType: "STOCK_CODE",
      override: safe,
    });
    expect(profile.headline).toBe("Thanh toán gói VIP");
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

    expect(labels(msg)).toEqual(
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
    expect([...msg.text].length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LIMIT);
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

describe("payment keyboard layout (K6)", () => {
  it("lays out the copy trio, check, and cancel in the mandated row order", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, silentQr);
    expect(msg.buttons.map((row) => row.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyAccount, PAYMENT_COPY.copyContent],
      [PAYMENT_COPY.copyAmount, PAYMENT_COPY.copyOrder],
      [PAYMENT_COPY.refresh],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);
    const flat = msg.buttons.flat();
    for (const button of flat.filter((candidate) => candidate.copyText)) {
      expect(button.callbackData).toBe("");
      expect(button.style).toBe("primary");
    }
    expect(flat.find((button) => button.text === PAYMENT_COPY.refresh)?.style).toBe("success");
    expect(flat.find((button) => button.text === PAYMENT_COPY.cancel)?.style).toBe("danger");
  });

  it("drops a disabled copy button without reordering the rest", () => {
    const profile = resolvePaymentPresentationProfile({});
    const keyboard = buildMobilePaymentKeyboard({
      presentation: PRESENTATION,
      profile: { ...profile, showAccountCopyButton: false },
      refreshCallbackData: "pay:refresh:ORD",
      cancelCallbackData: "pay:cancel:ORD",
    });
    expect(keyboard.map((row) => row.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyContent],
      [PAYMENT_COPY.copyAmount, PAYMENT_COPY.copyOrder],
      [PAYMENT_COPY.refresh],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);

    const noOrderCode = buildMobilePaymentKeyboard({
      presentation: PRESENTATION,
      profile: { ...profile, showOrderCodeCopyButton: false },
      refreshCallbackData: "pay:refresh:ORD",
      cancelCallbackData: "pay:cancel:ORD",
    });
    expect(noOrderCode.map((row) => row.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyAccount, PAYMENT_COPY.copyContent],
      [PAYMENT_COPY.copyAmount],
      [PAYMENT_COPY.refresh],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);

    const noCheck = buildMobilePaymentKeyboard({
      presentation: PRESENTATION,
      profile: { ...profile, showPaymentCheckButton: false },
      refreshCallbackData: "pay:refresh:ORD",
      cancelCallbackData: "pay:cancel:ORD",
    });
    expect(noCheck.map((row) => row.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyAccount, PAYMENT_COPY.copyContent],
      [PAYMENT_COPY.copyAmount, PAYMENT_COPY.copyOrder],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);
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

describe("payment QR rendering", () => {
  it("hands the renderer exactly the EMVCo payload built from the same input", async () => {
    const input = {
      bankBin: PRESENTATION.bankBin,
      accountNumber: PRESENTATION.accountNumber,
      accountName: PRESENTATION.accountName,
      amountVnd: PRESENTATION.amountVnd,
      transferContent: PRESENTATION.transferContent,
      orderNumber: PRESENTATION.orderNumber,
      expiresAt: new Date(PRESENTATION.expiresAt),
    };
    const presentation = presentPayment(input);
    let rendered: string | undefined;
    const msg = await presentPaymentScreen(presentation, {
      qrRenderer: async (payload) => {
        rendered = payload;
        return QR_BYTES;
      },
    });
    expect(rendered).toBe(
      buildVietQrPayload({
        bankBin: input.bankBin,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        amountVnd: input.amountVnd,
        transferContent: input.transferContent,
      }),
    );
    expect(rendered).toContain(String(input.amountVnd));
    expect(msg.photo).toEqual(QR_BYTES);
  });

  it("renders a locally generated square PNG at least 512px wide, with no network", async () => {
    const msg = await presentPaymentScreen(PRESENTATION);
    const photo = msg.photo as Buffer;
    expect(photo.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(pngWidth(photo)).toBeGreaterThanOrEqual(QR_RENDER_WIDTH_PX);
    expect(pngHeight(photo)).toBe(pngWidth(photo));
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
      qrRenderer: () => Promise.withResolvers<Buffer>().promise,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(QR_RENDER_TIMEOUT_MS - 50);
    expect(msg.photo).toBeUndefined();
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
    expect(copyValues(msg).length).toBeGreaterThanOrEqual(3);
  }, 8_000);

  it("falls back when the renderer returns an empty buffer", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      qrRenderer: async () => Buffer.alloc(0),
    });
    expect(msg.photo).toBeUndefined();
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
    expect(msg.text).toContain("0123456789");
    expect(msg.text).toContain("199.000");
    expect(msg.text).toContain("ORDABC123456");
    expect(copyValues(msg)).toEqual(
      expect.arrayContaining([{ text: PAYMENT_COPY.copyAmount, copyText: "199000" }]),
    );
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
    expect(
      msg.buttons
        .flat()
        .map((button) => button.callbackData)
        .includes("pay:cancel:ORD-20260913-A1B2C3D4"),
    ).toBe(true);
  });

  it("keeps the copy instruction when a fallback caption would overflow", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      productName: "X".repeat(400),
      variantName: "Y".repeat(400),
      fulfillmentType: "MANUAL_FULFILLMENT",
      profileOverride: { extraNotice: "N".repeat(160) },
      qrRenderer: async () => {
        throw new Error("QR_FETCH_FAILED");
      },
    });
    expect([...msg.text].length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LIMIT);
    // Never-dropped payment truth survives the trim.
    expect(msg.text).toContain("199.000");
    expect(msg.text).toContain("0123456789");
    expect(msg.text).toContain("ORDABC123456");
    expect(msg.text).toContain(PAYMENT_COPY.expiresLabel);
    // ...and so does the instruction that tells the customer to use the copy buttons.
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
  });
});

describe("copy contract (owner §7)", () => {
  it("copies the exact account, digit-only amount, memo, and public order code", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, silentQr);
    expect(copyValues(msg)).toEqual([
      { text: PAYMENT_COPY.copyAccount, copyText: "0123456789" },
      { text: PAYMENT_COPY.copyContent, copyText: "ORDABC123456" },
      { text: PAYMENT_COPY.copyAmount, copyText: "199000" },
      { text: PAYMENT_COPY.copyOrder, copyText: "ORD-20260913-A1B2C3D4" },
    ]);
  });

  it("handles one-character, limit-length, and over-limit copy payloads", async () => {
    const single = await presentPaymentScreen(
      { ...PRESENTATION, accountNumber: "1", transferContent: "A" },
      silentQr,
    );
    const singleCopies = copyValues(single);
    expect(singleCopies).toEqual(
      expect.arrayContaining([
        { text: PAYMENT_COPY.copyAccount, copyText: "1" },
        { text: PAYMENT_COPY.copyContent, copyText: "A" },
      ]),
    );

    const atLimit = "B".repeat(TELEGRAM_COPY_TEXT_LIMIT);
    const limitMsg = await presentPaymentScreen(
      { ...PRESENTATION, transferContent: atLimit },
      silentQr,
    );
    expect(copyValues(limitMsg)).toEqual(
      expect.arrayContaining([{ text: PAYMENT_COPY.copyContent, copyText: atLimit }]),
    );

    const overLimit = "C".repeat(TELEGRAM_COPY_TEXT_LIMIT + 40);
    const overMsg = await presentPaymentScreen(
      { ...PRESENTATION, transferContent: overLimit },
      silentQr,
    );
    const copy = copyValues(overMsg).find((button) => button.text === PAYMENT_COPY.copyContent);
    expect(copy?.copyText).toBe("C".repeat(TELEGRAM_COPY_TEXT_LIMIT));
    expect([...(copy?.copyText ?? "")].length).toBe(TELEGRAM_COPY_TEXT_LIMIT);
  });

  it("does not render a copy button for an empty payload", () => {
    const profile = resolvePaymentPresentationProfile({});
    const keyboard = buildMobilePaymentKeyboard({
      presentation: { ...PRESENTATION, accountNumber: "  ", transferContent: "" },
      profile,
      refreshCallbackData: "pay:refresh:ORD",
      cancelCallbackData: "pay:cancel:ORD",
    });
    expect(copyValues({ buttons: keyboard })).toEqual([
      { text: PAYMENT_COPY.copyAmount, copyText: "199000" },
      { text: PAYMENT_COPY.copyOrder, copyText: PRESENTATION.orderNumber },
    ]);
    expect(keyboard.map((row) => row.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyAmount, PAYMENT_COPY.copyOrder],
      [PAYMENT_COPY.refresh],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);
  });

  it("never copies an internal UUID, token, vault ref, or callback secret", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, silentQr);
    for (const value of copyValues(msg).map((button) => button.copyText as string)) {
      expect(value).not.toMatch(UUID_RE);
      expect(value).not.toMatch(SECRETISH_RE);
      expect(value).not.toMatch(/^pay:|^sup:/);
    }
    expect(sanitizeCopyText(PRESENTATION.transferContent)).toBe("ORDABC123456");
  });
});

describe("quantity display (K2)", () => {
  const cases: Array<[boolean, number | undefined, string | null]> = [
    [true, 3, "📦 Netflix Premium × 3"],
    [true, 1, "📦 Netflix Premium"],
    [true, undefined, "📦 Netflix Premium"],
    [false, 3, "📦 Netflix Premium"],
    [false, 1, "📦 Netflix Premium"],
    [false, undefined, "📦 Netflix Premium"],
  ];

  it.each(cases)(
    "showQuantity=%s quantity=%s renders %s",
    async (showQuantity, quantity, expected) => {
      const profile = resolvePaymentPresentationProfile({
        patch: { showQuantity },
      });
      const caption = buildPaymentCaption(
        PRESENTATION,
        quantity === undefined
          ? { productName: "Netflix Premium" }
          : { productName: "Netflix Premium", quantity },
        profile,
      );
      expect(caption.split("\n")).toContain(expected);
    },
  );
});

describe("fulfillment/override matrix", () => {
  const productOverride = parsePaymentPresentationOverride({
    headline: "Thanh toán gói VIP",
    extraNotice: "Gói kích hoạt sau khi ngân hàng xác nhận.",
  });

  const matrix: Array<{
    name: string;
    context: Parameters<typeof presentPaymentScreen>[1];
    expectedFulfillmentLine: string;
    expectedProductLine: string;
  }> = [
    {
      name: "DEFAULT",
      context: { productName: "Netflix Premium", variantName: "1 tháng" },
      expectedFulfillmentLine: "",
      expectedProductLine: "📦 Netflix Premium · 1 tháng",
    },
    {
      name: "STOCK_CODE",
      context: {
        productName: "Netflix Premium",
        variantName: "1 tháng",
        fulfillmentType: "STOCK_CODE",
      },
      expectedFulfillmentLine: "Thanh toán thành công → mã hàng được giao tự động.",
      expectedProductLine: "📦 Netflix Premium · 1 tháng",
    },
    {
      name: "QUANTITY_STOCK",
      context: {
        productName: "Netflix Premium",
        variantName: "1 tháng",
        quantity: 3,
        fulfillmentType: "QUANTITY_STOCK",
      },
      expectedFulfillmentLine: "Thanh toán thành công → số lượng được trừ khỏi kho.",
      expectedProductLine: "📦 Netflix Premium · 1 tháng × 3",
    },
    {
      name: "product override",
      context: {
        productName: "Cloud VPS",
        variantName: "1 năm",
        profileOverride: productOverride,
      },
      expectedFulfillmentLine: "",
      expectedProductLine: "📦 Cloud VPS · 1 năm",
    },
  ];

  it.each(matrix)("$name renders title, product, notes, copies, and actions", async (row) => {
    const msg = await presentPaymentScreen(PRESENTATION, row.context);
    const title =
      row.name === "product override"
        ? "Thanh toán gói VIP"
        : "💳 Thanh toán đơn #ORD-20260913-A1B2C3D4";
    expect(msg.text.split("\n")[0]).toBe(title);
    expect(msg.text).toContain(row.expectedProductLine);
    expect(msg.text).toContain(`💰 Tổng: 199.000`);
    expect(msg.text).toContain("💳 STK: 0123456789");
    expect(msg.text).toContain("📝 Nội dung CK: ORDABC123456");
    expect(msg.text).toContain("👤 Thụ hưởng: TIER20 SHOP");
    expect(msg.text).toContain("⏱️ Hết hạn: 16/07/2026 19:15 (GMT+7)");
    if (row.expectedFulfillmentLine) {
      expect(msg.text).toContain(row.expectedFulfillmentLine);
    }
    if (row.name === "product override") {
      expect(msg.text).toContain("Gói kích hoạt sau khi ngân hàng xác nhận.");
    }
    expect(msg.buttons.map((buttonRow) => buttonRow.map((button) => button.text))).toEqual([
      [PAYMENT_COPY.copyAccount, PAYMENT_COPY.copyContent],
      [PAYMENT_COPY.copyAmount, PAYMENT_COPY.copyOrder],
      [PAYMENT_COPY.refresh],
      [PAYMENT_COPY.cancel, PAYMENT_COPY.mainMenu],
    ]);
  });

  it("shows no quantity marker for QUANTITY_STOCK with quantity 1", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      productName: "Netflix Premium",
      quantity: 1,
      fulfillmentType: "QUANTITY_STOCK",
    });
    expect(msg.text).toContain("📦 Netflix Premium\n");
    expect(msg.text).not.toContain("× 1");
  });
});

describe("copy_text sanitization", () => {
  it("truncates to Telegram copy_text limit without splitting a code point", () => {
    const value = `${"A".repeat(255)}😀 extra`;
    const sanitized = sanitizeCopyText(value);
    expect([...sanitized].length).toBeLessThanOrEqual(TELEGRAM_COPY_TEXT_LIMIT);
    expect(sanitized.includes("\uFFFD")).toBe(false);
  });

  it("never splits an emoji when the caption is truncated", () => {
    const caption = buildPaymentCaption(
      { ...PRESENTATION, accountName: "🎉".repeat(200), bankName: "🏦".repeat(200) },
      { productName: "🎁".repeat(200), variantName: "🎈".repeat(200) },
      resolvePaymentPresentationProfile({ override: { extraNotice: "✨".repeat(160) } }),
    );
    expect([...caption].length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LIMIT);
    expect(caption.includes("\uFFFD")).toBe(false);
  });
});
