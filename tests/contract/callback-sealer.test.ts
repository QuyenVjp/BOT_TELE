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

  it("seals the deposit QR and the customer's deposit list into actor-bound tokens", async () => {
    const c = codec();
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "deposit",
        buttons: [
          [{ text: "pay", callbackData: `preorder:pay:${COMMAND_ID}` }],
          [{ text: "mine", callbackData: "cust:preorders" }],
        ],
      },
      { codec: c, telegramUserId: "123456789", resolveOrderId: async () => null },
    );

    const [pay, list] = sealed.buttons.map((row) => row[0]!.callbackData!);
    expect(c.verify(pay!, { telegramUserId: "123456789" })).toMatchObject({
      ok: true,
      value: { action: "PREORDER_PAY", resourceId: COMMAND_ID },
    });
    expect(c.verify(pay!, { telegramUserId: "999999999" })).toMatchObject({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
    expect(c.verify(list!, { telegramUserId: "123456789" })).toMatchObject({
      ok: true,
      value: { action: "PREORDER_LIST" },
    });
  });

  it("keeps native copy_text buttons unsealed", async () => {
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "pay",
        buttons: [
          [{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }],
          [{ text: "🏠 Menu", callbackData: "menu:main" }],
        ],
      },
      { codec: codec(), telegramUserId: "123456789", resolveOrderId: async () => null },
    );
    expect(sealed.buttons[0]![0]).toMatchObject({
      copyText: "0123456789",
      callbackData: "",
    });
    expect(sealed.buttons[1]![0]!.callbackData).toMatch(/^cb:/);
  });

  it("seals pay:refresh when resolveOrderId returns an order id", async () => {
    const tokenCodec = codec();
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "pay",
        buttons: [[{ text: "check", callbackData: "pay:refresh:ORD-20260716-ABCD1234" }]],
      },
      {
        codec: tokenCodec,
        telegramUserId: "123456789",
        resolveOrderId: async () => COMMAND_ID,
      },
    );
    const callbackData = sealed.buttons[0]![0]!.callbackData;
    expect(callbackData).toMatch(/^cb:/);
    expect(tokenCodec.verify(callbackData, { telegramUserId: "123456789" })).toEqual({
      ok: true,
      value: expect.objectContaining({
        action: "PAYMENT_REFRESH",
        resourceId: COMMAND_ID,
      }),
    });
  });

  it("keeps acknowledged delivery deletion readable", async () => {
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "delivery",
        buttons: [[{ text: "delete", callbackData: "delivery:delete" }]],
      },
      { codec: codec(), telegramUserId: "123456789", resolveOrderId: async () => null },
    );

    expect(sealed.buttons[0]![0]!.callbackData).toBe("delivery:delete");
  });
});
