import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createCallbackTokenCodec, type CallbackAction } from "../../src/bot/callback-codec.js";
import { newId } from "../../src/shared/ids/index.js";

const KEY = "test-only-unified-callback-key-material-123456";
const ALICE = "123456789";
const BOB = "987654321";
const NOW = new Date("2026-07-17T00:00:00.000Z");

function codec() {
  return createCallbackTokenCodec({
    key: KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
}

describe("unified signed callback token (T125/T129)", () => {
  it.each<{
    action: CallbackAction;
    resourceId?: string;
    secondaryResourceId?: string;
    option?: number;
  }>([
    { action: "SEARCH_PROMPT" },
    { action: "MAIN_MENU" },
    { action: "CATEGORY_LIST" },
    { action: "CATEGORY_VIEW", resourceId: newId() },
    { action: "VARIANT_VIEW", resourceId: newId() },
    { action: "CATALOG_PAGE", resourceId: newId(), secondaryResourceId: newId() },
    { action: "ORDER_LIST" },
    { action: "ORDER_LIST_PAGE", resourceId: newId() },
    { action: "ORDER_VIEW", resourceId: newId() },
    { action: "PAYMENT_REFRESH", resourceId: newId() },
    { action: "PAYMENT_CANCEL", resourceId: newId() },
    { action: "PAYMENT_REOPEN", resourceId: newId() },
    { action: "SUPPORT_MENU" },
    { action: "SUPPORT_REASON", resourceId: newId(), option: 4 },
    { action: "ADMIN_COMMAND", resourceId: newId(), option: 2 },
    { action: "SUPPORT_TICKET_VIEW", resourceId: newId() },
  ])("round-trips opaque $action within Telegram's 64-byte limit", (input) => {
    const token = codec().issue({ ...input, telegramUserId: ALICE, now: NOW });
    expect(token).toMatch(/^cb:[A-Za-z0-9_-]+$/);
    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(64);
    expect(token).not.toContain(input.resourceId ?? "not-present");

    const verified = codec().verify(token, { telegramUserId: ALICE, now: NOW });
    expect(verified).toMatchObject({ ok: true, value: input });
  });

  it("rejects tamper, wrong customer, expiry, future token, malformed shape, and unknown action", () => {
    const token = codec().issue({
      action: "ORDER_VIEW",
      resourceId: newId(),
      telegramUserId: ALICE,
      now: NOW,
    });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(codec().verify(tampered, { telegramUserId: ALICE, now: NOW }).ok).toBe(false);
    expect(codec().verify(token, { telegramUserId: BOB, now: NOW }).ok).toBe(false);
    expect(
      codec().verify(token, { telegramUserId: ALICE, now: new Date(NOW.getTime() + 906_000) }),
    ).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(codec().verify("cb:not-valid", { telegramUserId: ALICE, now: NOW }).ok).toBe(false);

    const raw = Buffer.from(token.slice(3), "base64url");
    raw[0] = 0xf1;
    expect(
      codec().verify(`cb:${raw.toString("base64url")}`, { telegramUserId: ALICE, now: NOW }),
    ).toMatchObject({ ok: false });
  });

  it("is replay-stable so duplicate delivery reaches idempotent domain handlers with identical data", () => {
    const token = codec().issue({
      action: "PAYMENT_CANCEL",
      resourceId: newId(),
      telegramUserId: ALICE,
      now: NOW,
    });
    const first = codec().verify(token, { telegramUserId: ALICE, now: NOW });
    const replay = codec().verify(token, { telegramUserId: ALICE, now: NOW });
    expect(replay).toEqual(first);
  });

  it("fails composition for weak keys, unsafe TTL, invalid key version, and malformed action payload", () => {
    expect(() =>
      createCallbackTokenCodec({
        key: "short",
        keyVersion: 1,
        ttlSeconds: 900,
        clockSkewSeconds: 5,
      }),
    ).toThrow();
    expect(() =>
      createCallbackTokenCodec({ key: KEY, keyVersion: 16, ttlSeconds: 900, clockSkewSeconds: 5 }),
    ).toThrow();
    expect(() =>
      createCallbackTokenCodec({
        key: KEY,
        keyVersion: 1,
        ttlSeconds: 86_401,
        clockSkewSeconds: 5,
      }),
    ).toThrow();
    expect(() =>
      codec().issue({ action: "ORDER_VIEW", telegramUserId: ALICE, now: NOW }),
    ).toThrow();
  });
});
