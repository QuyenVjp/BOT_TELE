import { describe, expect, it } from "vitest";
import { presentPaymentScreen } from "../../src/bot/presenters/payment.js";
import { buildVietQrPayload, presentPayment } from "../../src/modules/payments/vietqr.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";

/**
 * Owner acceptance §13 — the one-phone bank transfer.
 *
 * A customer holding ONE phone cannot scan a QR displayed on the same screen. The card
 * must therefore expose the account number, the amount, and the transfer content as native
 * Telegram copy buttons, plus an action that checks whether the bank has confirmed the
 * transfer. Pure presenter: no DB, no Docker, no network — the QR renderer is injected.
 */

const TRANSFER = {
  bankBin: "970422",
  accountNumber: "0931123456",
  accountName: "TIER20 SHOP",
  amountVnd: 199000,
  transferContent: "ORD20260914PHONE01",
  orderNumber: "ORD-20260914-PHONE001",
  expiresAt: new Date("2026-09-14T12:15:00.000Z"),
  bankName: "MB Bank",
  bankAlias: "MB",
};

const PRESENTATION: PaymentPresentation = presentPayment(TRANSFER);

const silentQr = {
  qrRenderer: async (payload: string) => {
    expect(payload).toBe(
      buildVietQrPayload({
        bankBin: TRANSFER.bankBin,
        accountNumber: TRANSFER.accountNumber,
        accountName: TRANSFER.accountName,
        amountVnd: TRANSFER.amountVnd,
        transferContent: TRANSFER.transferContent,
      }),
    );
    return Buffer.from("qr-png");
  },
};

describe("one-phone payment acceptance", () => {
  it("customer_can_complete_bank_transfer_on_one_phone_without_scanning_qr", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      status: "PENDING",
      productName: "Netflix Premium",
      variantName: "1 tháng",
      fulfillmentType: "STOCK_ACCOUNT",
      ...silentQr,
    });

    const copies = msg.buttons
      .flat()
      .filter((button) => button.copyText)
      .reduce<Record<string, string>>((acc, button) => {
        acc[button.text] = button.copyText as string;
        return acc;
      }, {});

    // The same phone can transfer without scanning: STK, amount, and memo are copyable.
    expect(copies["📋 Sao chép STK"]).toBe(TRANSFER.accountNumber);
    expect(copies["📋 Số tiền"]).toBe(String(TRANSFER.amountVnd));
    expect(copies["📋 Nội dung CK"]).toBe(TRANSFER.transferContent);

    // Every copy button is a native copy button, not a callback that needs a round-trip.
    for (const button of msg.buttons.flat().filter((candidate) => candidate.copyText)) {
      expect(button.callbackData).toBe("");
      expect(button.style).toBe("primary");
    }

    // The customer can then check whether the bank confirmed the transfer.
    const refresh = msg.buttons.flat().find((button) => button.text === "✅ Kiểm tra thanh toán");
    expect(refresh?.callbackData).toBe(`pay:refresh:${TRANSFER.orderNumber}`);
    expect(refresh?.style).toBe("success");

    // And the card still carries the human-readable bank facts.
    expect(msg.text).toContain(TRANSFER.accountNumber);
    expect(msg.text).toContain(TRANSFER.transferContent);
    expect(msg.text).toContain("199.000");
    expect(msg.text).toContain(TRANSFER.bankName);
    expect(msg.text).toContain("19:15");
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");

    // A cancelled order is still reachable from the same card.
    const cancel = msg.buttons.flat().find((button) => button.text === "❌ Huỷ đơn");
    expect(cancel?.callbackData).toBe(`pay:cancel:${TRANSFER.orderNumber}`);
  });

  it("still completes on one phone when the QR image cannot be produced", async () => {
    const msg = await presentPaymentScreen(PRESENTATION, {
      status: "PENDING",
      productName: "Netflix Premium",
      qrRenderer: async () => {
        throw new Error("QR_FETCH_FAILED");
      },
    });
    expect(msg.photo).toBeUndefined();
    const copyTexts = msg.buttons
      .flat()
      .filter((button) => button.copyText)
      .map((button) => button.copyText);
    expect(copyTexts).toEqual(
      expect.arrayContaining([
        TRANSFER.accountNumber,
        String(TRANSFER.amountVnd),
        TRANSFER.transferContent,
      ]),
    );
    expect(msg.buttons.flat().some((button) => button.text === "✅ Kiểm tra thanh toán")).toBe(
      true,
    );
    expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
    expect(msg.buttons.flat().some((button) => button.text === "❌ Huỷ đơn")).toBe(true);
  });
});
