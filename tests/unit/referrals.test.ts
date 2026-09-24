import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import fc from "fast-check";
import {
  isReferralTokenSafeForTelegram,
  issueReferralReward,
  REFERRAL_START_PARAM_MAX_BYTES,
} from "../../src/modules/referrals/service.js";

describe("referral rewards", () => {
  it("fails closed without touching the database when rewards are disabled", async () => {
    const result = await issueReferralReward(undefined as never, {
      orderId: "order-1",
      amountVnd: 10_000n,
      correlationId: "test-correlation",
      enabled: false,
    });

    expect(result).toEqual({ ok: false, code: "REWARDS_DISABLED" });
  });
});

describe("referral token boundary", () => {
  it("accepts the generated safe shape and rejects overlong or Unicode values", () => {
    expect(isReferralTokenSafeForTelegram(`ref_${"a".repeat(24)}.${"b".repeat(16)}`)).toBe(true);
    expect(
      isReferralTokenSafeForTelegram(`ref_${"a".repeat(REFERRAL_START_PARAM_MAX_BYTES)}.b`),
    ).toBe(false);
    expect(isReferralTokenSafeForTelegram("ref_тест.sig")).toBe(false);
  });

  it("preserves the Telegram-safe grammar for every accepted arbitrary token", () => {
    fc.assert(
      fc.property(fc.string(), (token) => {
        if (!isReferralTokenSafeForTelegram(token)) return;
        expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(
          REFERRAL_START_PARAM_MAX_BYTES,
        );
        expect(token).toMatch(/^ref_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      }),
    );
  });
});
