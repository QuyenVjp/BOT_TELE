import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_BANK_TRANSFER,
  parsePaymentPresentationOverride,
  resolvePaymentPresentationProfile,
  sanitizeCopyText,
  TELEGRAM_COPY_TEXT_LIMIT,
} from "../../src/bot/presenters/payment-presentation-profile.js";

describe("payment presentation profile", () => {
  it("defaults to the mobile bank-transfer card with check and cancel on", () => {
    const profile = resolvePaymentPresentationProfile({});
    expect(profile).toEqual(DEFAULT_MOBILE_BANK_TRANSFER);
    expect(profile.qrTemplate).toBe("compact");
    expect(profile.showQuantity).toBe(false);
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showAmountCopyButton).toBe(true);
    expect(profile.showTransferContentCopyButton).toBe(true);
  });

  it("adds a STOCK_CODE auto-delivery notice without hiding check or cancel", () => {
    const profile = resolvePaymentPresentationProfile({ fulfillmentType: "STOCK_CODE" });
    expect(profile.fulfillmentNotice).toContain("mã hàng được giao tự động");
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
    expect(profile.icon).toBe("key");
  });

  it("applies a sanitized headline override", () => {
    const profile = resolvePaymentPresentationProfile({
      override: { headline: "Thanh toán Netflix" },
    });
    expect(profile.headline).toBe("Thanh toán Netflix");
    expect(profile.showPaymentCheckButton).toBe(true);
  });

  it("rejects script, URL, and callback-shaped overrides", () => {
    expect(parsePaymentPresentationOverride({ headline: "<script>x</script>" })).toBeUndefined();
    expect(
      parsePaymentPresentationOverride({ extraNotice: "https://evil.example" }),
    ).toBeUndefined();
    expect(parsePaymentPresentationOverride({ extraNotice: "tg://share" })).toBeUndefined();
    expect(
      parsePaymentPresentationOverride({ extraNotice: "javascript:alert(1)" }),
    ).toBeUndefined();
    expect(
      parsePaymentPresentationOverride({ extraNotice: "callback pay:refresh" }),
    ).toBeUndefined();
    const profile = resolvePaymentPresentationProfile({
      override: { headline: "<script>x</script>" },
    });
    expect(profile.headline).toBeNull();
  });

  it("ignores overrides that try to change amount, account, or transfer content", () => {
    expect(
      parsePaymentPresentationOverride({
        headline: "OK",
        amountVnd: 1,
        accountNumber: "000",
        transferContent: "HACK",
      }),
    ).toBeUndefined();
    const profile = resolvePaymentPresentationProfile({
      override: {
        amount: 1,
        bankName: "Fake Bank",
        accountNumber: "000",
        showPaymentCheckButton: false,
        showCancelButton: false,
      },
    });
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
  });

  it("truncates copy_text payloads without splitting a code point", () => {
    const ok = sanitizeCopyText("ORD-20260716-ABCD1234");
    expect(ok).toBe("ORD-20260716-ABCD1234");
    const long = "A".repeat(TELEGRAM_COPY_TEXT_LIMIT + 8) + "🎉";
    const sliced = sanitizeCopyText(long);
    expect([...sliced].length).toBe(TELEGRAM_COPY_TEXT_LIMIT);
  });
});
