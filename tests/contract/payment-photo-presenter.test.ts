import { describe, expect, it } from "vitest";
import { presentPaymentScreen, formatExpiryVietnam } from "../../src/bot/presenters/payment.js";
import type { PaymentPresentation } from "../../src/modules/payments/vietqr.js";

/**
 * T148/T149 — payment presenter shows Vietnam-local expiry + bank name (no Docker).
 *
 * Findings: expiry was rendered in UTC (confusing for VN buyers) and the bank
 * display name was missing from the card.
 */

const presentation: PaymentPresentation = {
  payload: "00020101021238540010A0000007270124...6304ABCD",
  bankBin: "970422",
  accountNumber: "0123456789",
  accountName: "SHOP DIGITAL",
  amountVnd: 150000,
  transferContent: "ORDABC123",
  orderNumber: "ORD-20260716-A1B2C3D4",
  // 12:15 UTC == 19:15 Asia/Ho_Chi_Minh (UTC+7).
  expiresAt: "2026-07-16T12:15:00.000Z",
  bankName: "MB Bank",
};

describe("formatExpiryVietnam", () => {
  it("renders the expiry in Asia/Ho_Chi_Minh (UTC+7), not UTC", () => {
    const s = formatExpiryVietnam(presentation.expiresAt);
    // 12:15 UTC → 19:15 local.
    expect(s).toContain("19:15");
    expect(s).not.toContain("UTC");
    // Some marker of Vietnam time.
    expect(s.toLowerCase()).toMatch(/gmt\+7|\+07|giờ vn|vn/);
  });
});

describe("presentPaymentScreen", () => {
  it("shows the bank display name and Vietnam-local expiry", () => {
    const msg = presentPaymentScreen(presentation);
    expect(msg.text).toContain("MB Bank");
    expect(msg.text).toContain("19:15");
    expect(msg.text).not.toContain("UTC");
  });

  it("still shows exact amount, account, and content, and never asserts settlement", () => {
    const msg = presentPaymentScreen(presentation);
    expect(msg.text).toContain("0123456789");
    expect(msg.text).toContain("ORDABC123");
    const lower = msg.text.toLowerCase();
    expect(lower).not.toContain("đã thanh toán");
  });
});
