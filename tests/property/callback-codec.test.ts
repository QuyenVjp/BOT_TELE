import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CALLBACK_ACTION_CODES,
  createCallbackTokenCodec,
  MAX_CALLBACK_PRICE_VND,
  type CallbackAction,
} from "../../src/bot/callback-codec.js";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const KEY = "test-only-callback-property-key-material-123456";
const RESOURCE_ID = "01M226XN61E5SXARPBJ63M60SM";
const SECONDARY_RESOURCE_ID = "01M226XN61E5SXARPBJ63M60SN";

const NO_PAYLOAD_ACTIONS = [
  "SEARCH_PROMPT",
  "MAIN_MENU",
  "CATEGORY_LIST",
  "ORDER_LIST",
  "RESTOCK_LIST",
  "SHOP_HOME",
  "SHOP_OPEN",
  "CUSTOMER_NOTIFICATIONS",
  "CUSTOMER_WARRANTY",
  "PREORDER_LIST",
] as const satisfies readonly CallbackAction[];

const RESOURCE_ACTIONS = [
  "VARIANT_VIEW",
  "ORDER_LIST_PAGE",
  "ORDER_VIEW",
  "PAYMENT_REFRESH",
  "PAYMENT_CANCEL",
  "PAYMENT_REOPEN",
  "SUPPORT_TICKET_VIEW",
  "RESTOCK_SUBSCRIBE",
  "RESTOCK_UNSUBSCRIBE",
  "SHOP_PRODUCT",
  "SHOP_PAGE",
  "PREORDER_CONSENT",
  "PREORDER_CREATE",
  "PREORDER_PAY",
  "CUSTOMER_NOTIFICATION_TOGGLE",
  "CHECKOUT_PREVIEW",
] as const satisfies readonly CallbackAction[];

const COMPLEX_ACTIONS = [
  "CATEGORY_VIEW",
  "CATALOG_PAGE",
  "SUPPORT_MENU",
  "SUPPORT_REASON",
  "ADMIN_COMMAND",
] as const satisfies readonly CallbackAction[];

function codec() {
  return createCallbackTokenCodec({
    key: KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
}

function userIds() {
  return fc.bigInt({ min: 1n, max: 9_999_999_999_999_999_999n }).map(String);
}

describe("callback codec generative invariants", () => {
  it("round-trips every no-payload action for arbitrary valid Telegram IDs", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NO_PAYLOAD_ACTIONS), userIds(), (action, telegramUserId) => {
        const token = codec().issue({ action, telegramUserId, now: NOW });
        const verified = codec().verify(token, { telegramUserId, now: NOW });

        expect(verified).toMatchObject({ ok: true, value: { action } });
        if (verified.ok) {
          expect(verified.value.resourceId).toBeUndefined();
          expect(verified.value.secondaryResourceId).toBeUndefined();
          expect(verified.value.expiresAt).toEqual(new Date("2026-07-17T00:15:00.000Z"));
        }
      }),
      { numRuns: 128 },
    );
  });

  it("round-trips resource-bound actions without widening their customer scope", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RESOURCE_ACTIONS), userIds(), (action, telegramUserId) => {
        const token = codec().issue({ action, telegramUserId, resourceId: RESOURCE_ID, now: NOW });
        const verified = codec().verify(token, { telegramUserId, now: NOW });

        expect(verified).toMatchObject({ ok: true, value: { action, resourceId: RESOURCE_ID } });
        expect(codec().verify(token, { telegramUserId: `${telegramUserId}1`, now: NOW }).ok).toBe(
          false,
        );
      }),
      { numRuns: 128 },
    );
  });

  it("rejects a signature mutation at arbitrary token positions", () => {
    fc.assert(
      fc.property(userIds(), fc.nat(), (telegramUserId, offset) => {
        const token = codec().issue({
          action: "CATALOG_PAGE",
          telegramUserId,
          resourceId: RESOURCE_ID,
          secondaryResourceId: SECONDARY_RESOURCE_ID,
          now: NOW,
        });
        const encodedOffset = offset % (token.length - 3);
        const index = encodedOffset + 3;
        const replacement = token[index] === "A" ? "B" : "A";
        const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;

        expect(codec().verify(tampered, { telegramUserId, now: NOW }).ok).toBe(false);
      }),
      { numRuns: 128 },
    );
  });
  it("round-trips variable-width callback payload schemas", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...COMPLEX_ACTIONS),
        userIds(),
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        (action, telegramUserId, option, includeResource) => {
          const resourceId =
            includeResource ||
            action === "CATEGORY_VIEW" ||
            action === "CATALOG_PAGE" ||
            action === "ADMIN_COMMAND"
              ? RESOURCE_ID
              : undefined;
          const secondaryResourceId =
            action === "CATALOG_PAGE" && includeResource ? SECONDARY_RESOURCE_ID : undefined;
          const encodedOption =
            action === "CATEGORY_VIEW" || action === "SUPPORT_REASON" || action === "ADMIN_COMMAND"
              ? option
              : undefined;
          const token = codec().issue({
            action,
            telegramUserId,
            now: NOW,
            ...(resourceId === undefined ? {} : { resourceId }),
            ...(secondaryResourceId === undefined ? {} : { secondaryResourceId }),
            ...(encodedOption === undefined ? {} : { option: encodedOption }),
          });
          const verified = codec().verify(token, { telegramUserId, now: NOW });

          expect(verified).toMatchObject({ ok: true, value: { action } });
          if (verified.ok) {
            expect(verified.value.resourceId).toBe(resourceId);
            expect(verified.value.secondaryResourceId).toBe(secondaryResourceId);
            expect(verified.value.option).toBe(encodedOption);
          }
        },
      ),
      { numRuns: 128 },
    );
  });

  it("round-trips wallet price bounds and the optional purchase attempt", () => {
    fc.assert(
      fc.property(
        userIds(),
        fc.integer({ min: 1, max: MAX_CALLBACK_PRICE_VND }),
        fc.boolean(),
        (telegramUserId, amountVnd, includeAttempt) => {
          const secondaryResourceId = includeAttempt ? "AQIDBAUG" : undefined;
          const token = codec().issue({
            action: "CHECKOUT_WALLET",
            telegramUserId,
            resourceId: RESOURCE_ID,
            amountVnd,
            now: NOW,
            ...(secondaryResourceId === undefined ? {} : { secondaryResourceId }),
          });
          const verified = codec().verify(token, { telegramUserId, now: NOW });

          expect(verified).toMatchObject({
            ok: true,
            value: { action: "CHECKOUT_WALLET", resourceId: RESOURCE_ID, amountVnd },
          });
          if (verified.ok) expect(verified.value.secondaryResourceId).toBe(secondaryResourceId);
        },
      ),
      { numRuns: 128 },
    );
  });

  it("keeps the action-code table injective", () => {
    const codes = Object.values(CALLBACK_ACTION_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
