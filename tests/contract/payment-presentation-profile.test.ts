import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_BANK_TRANSFER,
  parsePaymentPresentationOverride,
  resolvePaymentPresentationProfile,
  sanitizeCopyText,
  TELEGRAM_COPY_TEXT_LIMIT,
} from "../../src/bot/presenters/payment-presentation-profile.js";
import { FULFILLMENT_TYPES } from "../../src/modules/catalog/fulfillment-type.js";

describe("payment presentation profile", () => {
  it("defaults to the mobile bank-transfer card with check and cancel on", () => {
    const profile = resolvePaymentPresentationProfile({});
    expect(profile).toEqual(DEFAULT_MOBILE_BANK_TRANSFER);
    expect(profile.showQuantity).toBe(false);
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
    expect(profile.showAccountCopyButton).toBe(true);
    expect(profile.showAmountCopyButton).toBe(true);
    expect(profile.showTransferContentCopyButton).toBe(true);
  });

  it("carries no field that cannot change the rendered card", () => {
    // K1: profileId / qrTemplate / icon were removed — none of them changed output.
    for (const dead of ["profileId", "qrTemplate", "icon"]) {
      expect(Object.keys(DEFAULT_MOBILE_BANK_TRANSFER)).not.toContain(dead);
    }
  });

  it("adds a STOCK_CODE auto-delivery notice without hiding check or cancel", () => {
    const profile = resolvePaymentPresentationProfile({ fulfillmentType: "STOCK_CODE" });
    expect(profile.fulfillmentNotice).toContain("mã hàng được giao tự động");
    expect(profile.showPaymentCheckButton).toBe(true);
    expect(profile.showCancelButton).toBe(true);
  });

  it("resolves every real fulfillment type with the copy trio and check intact", () => {
    for (const fulfillmentType of FULFILLMENT_TYPES) {
      const profile = resolvePaymentPresentationProfile({ fulfillmentType });
      expect(profile.fulfillmentNotice).toBeTruthy();
      expect(profile.showAccountCopyButton).toBe(true);
      expect(profile.showAmountCopyButton).toBe(true);
      expect(profile.showTransferContentCopyButton).toBe(true);
      expect(profile.showPaymentCheckButton).toBe(true);
      expect(profile.showCancelButton).toBe(true);
    }
    expect(
      resolvePaymentPresentationProfile({ fulfillmentType: "QUANTITY_STOCK" }).showQuantity,
    ).toBe(true);
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

  it("still rejects override keys that were deleted from the schema", () => {
    // Strict schema: a removed key is not "ignored", it invalidates the whole override so
    // stale product metadata can never smuggle presentation state back in.
    expect(
      parsePaymentPresentationOverride({ headline: "OK", qrTemplate: "qronly" }),
    ).toBeUndefined();
    expect(parsePaymentPresentationOverride({ headline: "OK", icon: "key" })).toBeUndefined();
    expect(
      parsePaymentPresentationOverride({ headline: "OK", profileId: "STOCK_CODE" }),
    ).toBeUndefined();
    expect(parsePaymentPresentationOverride({ headline: "OK" })).toEqual({ headline: "OK" });
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

  it("keeps short copy payloads and trims only surrounding whitespace", () => {
    expect(sanitizeCopyText("a")).toBe("a");
    expect(sanitizeCopyText(`  ${"b".repeat(TELEGRAM_COPY_TEXT_LIMIT)}  `)).toBe(
      "b".repeat(TELEGRAM_COPY_TEXT_LIMIT),
    );
    const over = sanitizeCopyText("c".repeat(TELEGRAM_COPY_TEXT_LIMIT + 1));
    expect(over).toBe("c".repeat(TELEGRAM_COPY_TEXT_LIMIT));
    expect(sanitizeCopyText("")).toBe("");
  });
});
