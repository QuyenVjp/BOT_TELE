import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { processDeliveryNotificationBatch } from "../../src/modules/digital-goods/delivery-notification.js";
import { verifyDeliverySessionToken } from "../../src/modules/digital-goods/delivery-session.js";

const CURRENT_KEY = "current-delivery-session-key-material-123456789";
const PREVIOUS_KEY = "previous-delivery-session-key-material-12345678";
const NOW = new Date("2026-07-17T12:00:00.000Z");

function token(input: { key: string; keyVersion: number; expiresAt?: number }): string {
  const claims = {
    sessionId: "01KXROTATIONSESSION000000001",
    bundleId: "01KXROTATIONBUNDLE0000000001",
    customerId: "01KXROTATIONCUSTOMER00000001",
    telegramUserId: "7788990011",
    audience: "delivery-reveal",
    nonce: "abcdefghijklmnopqrstuvwxyzABCDEF",
    expiresAt: input.expiresAt ?? Math.floor(NOW.getTime() / 1000) + 300,
    keyVersion: input.keyVersion,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", input.key)
    .update("telegram-shop:delivery-session:v1\0", "utf8")
    .update(payload, "utf8")
    .digest("base64url");
  return `ds1.${payload}.${signature}`;
}

describe("delivery-session key rotation (T182)", () => {
  const graceConfig = {
    key: CURRENT_KEY,
    keyVersion: 4,
    previousKey: PREVIOUS_KEY,
    previousKeyVersion: 3,
    previousKeyGraceUntil: new Date(NOW.getTime() + 60_000),
    audience: "delivery-reveal",
  };

  it("accepts current and previous versions only during explicit grace", () => {
    expect(
      verifyDeliverySessionToken(token({ key: CURRENT_KEY, keyVersion: 4 }), graceConfig, NOW),
    ).not.toBeNull();
    expect(
      verifyDeliverySessionToken(token({ key: PREVIOUS_KEY, keyVersion: 3 }), graceConfig, NOW),
    ).not.toBeNull();
    expect(
      verifyDeliverySessionToken(
        token({ key: PREVIOUS_KEY, keyVersion: 3 }),
        { key: CURRENT_KEY, keyVersion: 4, audience: "delivery-reveal" },
        NOW,
      ),
    ).toBeNull();
  });

  it("rejects an unknown version and an expired previous-key token", () => {
    expect(
      verifyDeliverySessionToken(token({ key: CURRENT_KEY, keyVersion: 9 }), graceConfig, NOW),
    ).toBeNull();
    expect(
      verifyDeliverySessionToken(
        token({
          key: PREVIOUS_KEY,
          keyVersion: 3,
          expiresAt: Math.floor(NOW.getTime() / 1000) - 1,
        }),
        graceConfig,
        NOW,
      ),
    ).toBeNull();
  });

  it("rejects a previous-key token after the explicit grace deadline even if the token is live", () => {
    expect(
      verifyDeliverySessionToken(
        token({ key: PREVIOUS_KEY, keyVersion: 3 }),
        graceConfig,
        new Date(NOW.getTime() + 61_000),
      ),
    ).toBeNull();
  });

  it("rejects the previous key at the exact grace-until instant", () => {
    expect(
      verifyDeliverySessionToken(
        token({ key: PREVIOUS_KEY, keyVersion: 3 }),
        graceConfig,
        graceConfig.previousKeyGraceUntil,
      ),
    ).toBeNull();
  });

  it("fails before database access when the production notification path omits session config", async () => {
    const input = {
      db: {} as Db,
      vault: {} as Vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "missing-session-config",
      batchSize: 1,
      maxAttempts: 3,
    } as unknown as Parameters<typeof processDeliveryNotificationBatch>[0];

    await expect(processDeliveryNotificationBatch(input)).rejects.toThrow(
      /delivery session configuration/i,
    );
  });
});
