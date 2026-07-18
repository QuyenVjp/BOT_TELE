import { describe, expect, it } from "vitest";
import {
  presentPaymentScreen,
  presentPaymentExpired,
  presentPaymentSettled,
  presentPaymentNeedsReview,
  PAYMENT_COPY,
} from "../../src/bot/presenters/payment.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";

/**
 * T055 — Vietnamese payment/expiry/review presenters (telegram-ux.md Presentation rules).
 *
 * The payment screen shows EXACT amount/content/expiry and explicitly states no
 * receipt screenshot is required. Presenters never assert settlement from the QR
 * and never instruct the user to send a screenshot.
 */

const PRESENTATION: PaymentPresentation = {
  payload: "00020101021238...6304ABCD",
  bankBin: "970422",
  accountNumber: "0123456789",
  accountName: "SHOP DIGITAL MVP",
  amountVnd: 199000,
  transferContent: "ORD20260716ABCD",
  orderNumber: "ORD-20260716-ABCD1234",
  expiresAt: "2026-07-16T12:15:00.000Z",
};

function allText(msg: {
  text: string;
  buttons: { text: string; callbackData: string }[][];
}): string {
  return (
    msg.text +
    " " +
    msg.buttons
      .flat()
      .map((b) => b.text)
      .join(" ")
  ).toLowerCase();
}

describe("payment screen presenter (FR-008)", () => {
  it("shows exact amount, transfer content, and expiry", () => {
    const msg = presentPaymentScreen(PRESENTATION);
    expect(msg.text).toContain("199.000");
    expect(msg.text).toContain(PRESENTATION.transferContent);
    expect(msg.text).toContain(PRESENTATION.accountNumber);
    // Expiry rendered in a human form (contains the date).
    expect(msg.text).toMatch(/2026/);
  });

  it("explicitly says no receipt screenshot is required", () => {
    const msg = presentPaymentScreen(PRESENTATION);
    const text = msg.text.toLowerCase();
    expect(text).toContain("không cần");
    expect(text).toMatch(/ảnh|chụp|screenshot|biên lai/);
  });

  it("never instructs the user to send a screenshot", () => {
    const msg = presentPaymentScreen(PRESENTATION);
    // Imperative "please send a screenshot" is forbidden; the negation
    // "không cần gửi ảnh" is the required copy and must stay allowed.
    expect(allText(msg)).not.toMatch(/(?:vui lòng|hãy)\s+gửi.*(ảnh|biên lai|screenshot)/);
    expect(allText(msg)).not.toMatch(/(?<!không\s)cần\s+gửi.*(ảnh|biên lai|screenshot)/);
  });

  it("offers status refresh and cancel actions bound to the order", () => {
    const msg = presentPaymentScreen(PRESENTATION);
    const data = msg.buttons.flat().map((b) => b.callbackData);
    expect(data.some((d) => d.startsWith("pay:refresh:"))).toBe(true);
    expect(data.some((d) => d.startsWith("pay:cancel:"))).toBe(true);
  });

  it("does not assert settlement on the payment screen", () => {
    const msg = presentPaymentScreen(PRESENTATION);
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
  });
});

describe("terminal payment presenters", () => {
  it("expired screen offers a reopen action and no screenshot instruction", () => {
    const msg = presentPaymentExpired(PRESENTATION.orderNumber);
    expect(msg.text.toLowerCase()).toContain("hết hạn");
    const data = msg.buttons.flat().map((b) => b.callbackData);
    expect(data.some((d) => d.startsWith("pay:reopen:"))).toBe(true);
  });

  it("settled screen confirms payment and shows the order number", () => {
    const msg = presentPaymentSettled(PRESENTATION.orderNumber);
    expect(msg.text.toLowerCase()).toContain("đã thanh toán");
    expect(msg.text).toContain(PRESENTATION.orderNumber);
  });

  it("needs-review screen surfaces a safe reference and support path, not a mark-paid", () => {
    const msg = presentPaymentNeedsReview(PRESENTATION.orderNumber, "corr-abc123");
    expect(msg.text.toLowerCase()).toMatch(/kiểm tra|đối soát|xem lại/);
    expect(msg.text).toContain("corr-abc123");
    const data = msg.buttons.flat().map((b) => b.callbackData);
    expect(data.some((d) => d.startsWith("sup:"))).toBe(true);
  });
});

describe("copy safety", () => {
  it("exposes stable Vietnamese copy without screenshot instructions", () => {
    const joined = Object.values(PAYMENT_COPY).join(" ").toLowerCase();
    // Forbid imperative "please send a screenshot"; allow the "không cần gửi" negation.
    expect(joined).not.toMatch(/(?:vui lòng|hãy)\s+gửi.*(ảnh|biên lai|screenshot)/);
    expect(joined).not.toMatch(/(?<!không\s)cần\s+gửi.*(ảnh|biên lai|screenshot)/);
    expect(joined).toContain("không cần gửi ảnh");
  });
});
