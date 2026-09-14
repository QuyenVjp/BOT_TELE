import { describe, expect, it } from "vitest";
import { presentPaymentCancelled, presentPaymentScreen } from "../../src/bot/presenters/payment.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";

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

function callbacks(msg: { buttons: { callbackData: string }[][] }): string[] {
  return msg.buttons
    .flat()
    .map((button) => button.callbackData)
    .filter(Boolean);
}

describe("payment screen lifecycle buttons", () => {
  it("PENDING keeps copy, check, and cancel", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      status: "PENDING",
      qrRenderer: async () => Buffer.from("qr"),
    });
    const data = callbacks(msg);
    expect(data.some((value) => value.startsWith("pay:refresh:"))).toBe(true);
    expect(data.some((value) => value.startsWith("pay:cancel:"))).toBe(true);
    expect(msg.buttons.flat().some((button) => button.copyText)).toBe(true);
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
  });

  it("CHECK_PENDING keeps copy and check, and does not claim paid", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      status: "CHECK_PENDING",
      qrRenderer: async () => Buffer.from("qr"),
    });
    const data = callbacks(msg);
    expect(msg.text).toContain("Chưa nhận được thanh toán");
    expect(data.some((value) => value.startsWith("pay:refresh:"))).toBe(true);
    expect(data.some((value) => value.startsWith("pay:cancel:"))).toBe(true);
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
  });

  it("PAID drops copy, check, and cancel", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, { status: "PAID" });
    const data = callbacks(msg);
    expect(msg.text.toLowerCase()).toContain("đã thanh toán");
    expect(data.some((value) => value.startsWith("pay:refresh:"))).toBe(false);
    expect(data.some((value) => value.startsWith("pay:cancel:"))).toBe(false);
    expect(msg.buttons.flat().some((button) => button.copyText)).toBe(false);
    expect(msg.photo).toBeUndefined();
  });

  it("EXPIRED drops copy/check/cancel and keeps reopen", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, { status: "EXPIRED" });
    const data = callbacks(msg);
    expect(msg.text.toLowerCase()).toContain("hết hạn");
    expect(data.some((value) => value.startsWith("pay:reopen:"))).toBe(true);
    expect(data.some((value) => value.startsWith("pay:refresh:"))).toBe(false);
    expect(data.some((value) => value.startsWith("pay:cancel:"))).toBe(false);
    expect(msg.buttons.flat().some((button) => button.copyText)).toBe(false);
  });

  it("CANCELLED is menu-only", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, { status: "CANCELLED" });
    const cancelled = presentPaymentCancelled(PRESENTATION.orderNumber);
    expect(msg.text).toBe(cancelled.text);
    const data = callbacks(msg);
    expect(data).toEqual(["menu:main"]);
    expect(msg.buttons.flat().some((button) => button.copyText)).toBe(false);
  });
});
