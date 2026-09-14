import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_COPY,
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  presentPaymentScreen,
} from "../../src/bot/presenters/payment.js";
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
  bankName: "MB Bank",
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/telegram");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8").replace(/\n$/, "");
}

describe("mobile copy buttons", () => {
  it("copies exact STK, digit-only amount, transfer content, and order code", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      qrRenderer: async () => Buffer.from("qr-png"),
    });
    const copies = msg.buttons.flat().filter((button) => button.copyText);
    expect(copies.map((button) => button.copyText)).toEqual([
      "0123456789",
      "ORD20260716ABCD",
      "199000",
      "ORD-20260716-ABCD1234",
    ]);
    expect(copies.every((button) => button.callbackData === "")).toBe(true);
    expect(copies.every((button) => button.style === "primary")).toBe(true);
    expect(msg.text).toContain("199.000");
    expect(msg.text).not.toContain("Mini App");
  });

  it("keeps one-phone copy when the QR renderer rejects", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      qrRenderer: async () => {
        throw new Error("qr failed");
      },
    });
    expect(msg.photo).toBeUndefined();
    expect(msg.text).toContain(PAYMENT_COPY.qrFallback);
    const copies = msg.buttons.flat().filter((button) => button.copyText);
    expect(copies.map((button) => button.copyText)).toEqual(
      expect.arrayContaining(["0123456789", "199000", "ORD20260716ABCD"]),
    );
    expect(msg.text.length).toBeLessThanOrEqual(TELEGRAM_PHOTO_CAPTION_LIMIT);
  });

  it("matches frozen default / stock-code / check-pending captions", async () => {
    const silentQr = { qrRenderer: async () => Buffer.from("qr-png") };
    const def = await presentPaymentScreen(PRESENTATION, silentQr);
    expect(def.text).toBe(fixture("payment-card-default.txt"));

    const stock = await presentPaymentScreen(PRESENTATION, {
      ...silentQr,
      productName: "Netflix Premium",
      variantName: "1 tháng",
      fulfillmentType: "STOCK_CODE",
    });
    expect(stock.text).toBe(fixture("payment-card-stock-code.txt"));
    expect(stock.text).toContain("mã hàng được giao tự động");

    const pending = await presentPaymentScreen(PRESENTATION, {
      ...silentQr,
      status: "CHECK_PENDING",
    });
    expect(pending.text).toBe(fixture("payment-card-check-pending.txt"));
    expect(pending.text).toContain("Chưa nhận được thanh toán");
    expect(pending.text).toContain("Hệ thống sẽ tự cập nhật ngay khi ngân hàng xác nhận");
  });
});
