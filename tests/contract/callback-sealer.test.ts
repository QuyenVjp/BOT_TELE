import { describe, expect, it } from "vitest";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { sealPresentedMessageCallbacks } from "../../src/bot/callback-sealer.js";

const KEY = "test-only-telegram-dispatch-key-material-123456";

function codec() {
  return createCallbackTokenCodec({
    key: KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
}

const COMMAND_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("callback sealing", () => {
  it("keeps admin dashboard navigation readable", async () => {
    const message = {
      text: "admin",
      buttons: [[{ text: "Dashboard", callbackData: "admin:dashboard" }]],
    };

    const sealed = await sealPresentedMessageCallbacks(message, {
      codec: codec(),
      telegramUserId: "123456789",
      resolveOrderId: async () => null,
    });

    expect(sealed.buttons[0]![0]!.callbackData).toBe("admin:dashboard");
  });

  it("keeps product draft category choices readable", async () => {
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "category",
        buttons: [[{ text: "CANARY", callbackData: "admin:products:category:cat-canary" }]],
      },
      {
        codec: codec(),
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    expect(sealed.buttons[0]![0]!.callbackData).toBe("admin:products:category:cat-canary");
  });

  it("seals numeric admin commands for the current actor", async () => {
    const tokenCodec = codec();
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "confirm",
        buttons: [[{ text: "Confirm", callbackData: `admin:7:${COMMAND_ID}` }]],
      },
      {
        codec: tokenCodec,
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    const callbackData = sealed.buttons[0]![0]!.callbackData;
    const verified = tokenCodec.verify(callbackData, { telegramUserId: "123456789" });

    expect(callbackData).toMatch(/^cb:/);
    expect(verified).toEqual({
      ok: true,
      value: expect.objectContaining({
        action: "ADMIN_COMMAND",
        option: 7,
        resourceId: COMMAND_ID,
      }),
    });
  });

  it("binds sealed numeric admin commands to the issuing actor", async () => {
    const tokenCodec = codec();
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "confirm",
        buttons: [[{ text: "Confirm", callbackData: `admin:7:${COMMAND_ID}` }]],
      },
      {
        codec: tokenCodec,
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    expect(
      tokenCodec.verify(sealed.buttons[0]![0]!.callbackData, { telegramUserId: "987654321" }),
    ).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });

  it("drops oversized numeric admin options instead of leaving them executable", async () => {
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "confirm",
        buttons: [[{ text: "Confirm", callbackData: `admin:999:${COMMAND_ID}` }]],
      },
      {
        codec: codec(),
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    expect(sealed.buttons).toEqual([]);
  });

  it("preserves supported wallet callbacks readable", async () => {
    const walletCallbacks = [
      "wallet:account",
      "wallet:topup",
      "wallet:topup:amount:50000",
      "wallet:topup:amount:100000",
      "wallet:topup:amount:200000",
      "wallet:topup:amount:500000",
      "wallet:topup:amount:1000000",
      "wallet:topup:custom",
      "wallet:topup:confirm",
      "wallet:topup:status",
      "wallet:topup:change",
      "wallet:topup:cancel",
    ];

    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "wallet",
        buttons: walletCallbacks.map((callbackData) => [{ text: callbackData, callbackData }]),
      },
      {
        codec: codec(),
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    expect(sealed.buttons.map((row) => row[0]!.callbackData)).toEqual(walletCallbacks);
  });

  it("drops unsupported wallet callbacks", async () => {
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "wallet",
        buttons: [[{ text: "bad", callbackData: "wallet:topup:unsupported" }]],
      },
      {
        codec: codec(),
        telegramUserId: "123456789",
        resolveOrderId: async () => null,
      },
    );

    expect(sealed.buttons).toEqual([]);
  });
});
