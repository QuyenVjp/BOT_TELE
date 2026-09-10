import { Buffer } from "node:buffer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_ACTION_CODES,
  createBuyNowCallbackCodec,
  createCallbackTokenCodec,
  MAX_CALLBACK_PRICE_VND,
  peekCallbackAction,
} from "../../src/bot/callback-codec.js";
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

const unified = () =>
  createCallbackTokenCodec({ key: KEY, keyVersion: 1, ttlSeconds: 900, clockSkewSeconds: 5 });

describe("checkout callback tokens", () => {
  createCallbackTokenCodec({ key: KEY, keyVersion: 1, ttlSeconds: 900, clockSkewSeconds: 5 });

  it("peeks EVERY action back to itself, including the extended (>=16) forms", () => {
    const variantId = newId();
    for (const action of Object.keys(CALLBACK_ACTION_CODES) as Array<
      keyof typeof CALLBACK_ACTION_CODES
    >) {
      // Build a minimal valid payload for each action so the peek is what is under test.
      const needsResource = ![
        "SEARCH_PROMPT",
        "MAIN_MENU",
        "CATEGORY_LIST",
        "ORDER_LIST",
        "RESTOCK_LIST",
        "PREORDER_LIST",
        "SHOP_HOME",
        "SHOP_OPEN",
        "CUSTOMER_NOTIFICATIONS",
        "CUSTOMER_WARRANTY",
      ].includes(action);
      const token = unified().issue({
        action,
        telegramUserId: TELEGRAM_USER_ID,
        ...(needsResource ? { resourceId: variantId } : {}),
        ...(action === "SUPPORT_REASON" || action === "ADMIN_COMMAND" ? { option: 1 } : {}),
        ...(action === "CHECKOUT_WALLET" ? { amountVnd: 199_000 } : {}),
      });
      expect(peekCallbackAction(token)).toBe(action);
    }
  });

  it("rejects a wallet token with no confirmed price", () => {
    expect(() =>
      unified().issue({
        action: "CHECKOUT_WALLET",
        telegramUserId: TELEGRAM_USER_ID,
        resourceId: newId(),
      }),
    ).toThrow(/amount/i);
  });

  it.each(["CHECKOUT_PREVIEW", "CHECKOUT_WALLET"] as const)(
    "round-trips %s as a variant-scoped token inside Telegram's 64-byte limit",
    (action) => {
      const variantId = newId();
      const now = new Date("2026-07-17T00:00:00.000Z");
      // The wallet choice binds the price the customer confirmed, so the charge can never
      // drift from what the confirmation screen showed.
      const amountVnd = action === "CHECKOUT_WALLET" ? 199_000 : undefined;
      const token = unified().issue({
        action,
        telegramUserId: TELEGRAM_USER_ID,
        resourceId: variantId,
        ...(amountVnd === undefined ? {} : { amountVnd }),
        now,
      });
      expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(64);
      expect(token.startsWith("cb:")).toBe(true);

      const verified = unified().verify(token, {
        telegramUserId: TELEGRAM_USER_ID,
        now: new Date(now.getTime() + 1_000),
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.action).toBe(action);
      expect(verified.value.resourceId).toBe(variantId);
      if (amountVnd !== undefined) expect(verified.value.amountVnd).toBe(amountVnd);
    },
  );

  it("binds checkout tokens to the issuing customer", () => {
    const token = unified().issue({
      action: "CHECKOUT_WALLET",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: newId(),
      amountVnd: 199_000,
    });
    expect(unified().verify(token, { telegramUserId: "999" }).ok).toBe(false);
  });

  // The sealer maps `cat:view:<categoryId>:<page>` to CATEGORY_VIEW with an option, so the codec has
  // to accept it: refusing the page number made every listing with more than one page throw at
  // render time, and the customer simply never saw the family.
  it("round-trips a paginated category view, page number included", () => {
    const codec = createCallbackTokenCodec({
      key: "test-only-callback-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const categoryId = "01M226XN61E5SXARPBJ63M60SM";
    const paged = codec.issue({
      action: "CATEGORY_VIEW",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: categoryId,
      option: 3,
    });
    expect(Buffer.byteLength(paged, "utf8")).toBeLessThanOrEqual(64);
    const verified = codec.verify(paged, { telegramUserId: TELEGRAM_USER_ID });
    expect(verified).toMatchObject({ ok: true });
    if (!verified.ok) return;
    expect(verified.value).toMatchObject({
      action: "CATEGORY_VIEW",
      resourceId: categoryId,
      option: 3,
    });

    // the first page still works without the option byte
    const plain = codec.issue({
      action: "CATEGORY_VIEW",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: categoryId,
    });
    const plainVerified = codec.verify(plain, { telegramUserId: TELEGRAM_USER_ID });
    expect(plainVerified.ok && plainVerified.value.option).toBe(undefined);
  });
});
