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

describe("callback sealing", () => {
  it("keeps admin callbacks readable for the admin dispatcher", async () => {
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
});
