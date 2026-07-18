import { Buffer } from "node:buffer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBuyNowCallbackCodec, MAX_CALLBACK_PRICE_VND } from "../../src/bot/callback-codec.js";
import { newId } from "../../src/shared/ids/index.js";

const KEY = "test-only-buy-now-callback-key-material-v1";
const TELEGRAM_USER_ID = "1234567890123456789";

function codec() {
  return createBuyNowCallbackCodec({
    key: KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
}

describe("signed Buy Now callback codec (T160)", () => {
  it("round-trips every bounded price/nonce case within Telegram's 64-byte limit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_CALLBACK_PRICE_VND }),
        fc.uint8Array({ minLength: 8, maxLength: 8 }),
        (expectedPriceVnd, nonce) => {
          const variantId = newId();
          const now = new Date("2026-07-17T00:00:00.000Z");
          const token = codec().issue({
            telegramUserId: TELEGRAM_USER_ID,
            variantId,
            expectedPriceVnd,
            now,
            nonce,
          });
          expect(Buffer.byteLength(token, "utf8")).toBeGreaterThan(0);
          expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(64);

          const verified = codec().verify(token, {
            telegramUserId: TELEGRAM_USER_ID,
            now: new Date(now.getTime() + 1_000),
          });
          expect(verified.ok).toBe(true);
          if (!verified.ok) return;
          expect(verified.value.variantId).toBe(variantId);
          expect(verified.value.expectedPriceVnd).toBe(expectedPriceVnd);
          expect(verified.value.idempotencyKey).toMatch(/^buy:v1:/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects tampering, expiry, wrong action, wrong user, and malformed payloads", () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    const token = codec().issue({
      telegramUserId: TELEGRAM_USER_ID,
      variantId: newId(),
      expectedPriceVnd: 199_000,
      now,
      nonce: new Uint8Array(8).fill(7),
    });
    const raw = Buffer.from(token.slice(4), "base64url");
    const wrongAction = Buffer.from(raw);
    wrongAction[0] = (wrongAction[0]! & 0xcf) | 0x20;

    expect(
      codec().verify(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), {
        telegramUserId: TELEGRAM_USER_ID,
        now,
      }).ok,
    ).toBe(false);
    expect(
      codec().verify(token, {
        telegramUserId: TELEGRAM_USER_ID,
        now: new Date(now.getTime() + 906_000),
      }),
    ).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(
      codec().verify(`buy:${wrongAction.toString("base64url")}`, {
        telegramUserId: TELEGRAM_USER_ID,
        now,
      }),
    ).toMatchObject({ ok: false, code: "WRONG_ACTION" });
    expect(codec().verify(token, { telegramUserId: "999", now }).ok).toBe(false);
    expect(
      codec().verify("not-a-valid-callback", { telegramUserId: TELEGRAM_USER_ID, now }).ok,
    ).toBe(false);
  });
});
