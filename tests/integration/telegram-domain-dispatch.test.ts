import { describe, expect, it, vi } from "vitest";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import { newId } from "../../src/shared/ids/index.js";

const USER = "123456789";
const CUSTOMER = newId();
const KEY = "test-only-telegram-dispatch-key-material-123456";

function setup() {
  const codec = createCallbackTokenCodec({
    key: KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
  const mainMenu = vi.fn().mockResolvedValue({
    text: "menu",
    buttons: [[{ text: "orders", callbackData: "ord:list" }]],
  });
  const order = {
    id: newId(),
    orderNumber: "ORD-TEST-1",
    customerId: CUSTOMER,
    createdAt: new Date().toISOString(),
  };
  const refresh = vi.fn().mockResolvedValue({
    text: "pending",
    buttons: [[{ text: "cancel", callbackData: `pay:cancel:${order.orderNumber}` }]],
  });
  const send = vi.fn().mockResolvedValue(undefined);
  const dispatcher = createTelegramDomainDispatcher({
    codec,
    resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
    resolveOrderById: vi
      .fn()
      .mockImplementation(async (id: string) => (id === order.id ? order : null)),
    resolveOrderIdByNumber: vi
      .fn()
      .mockImplementation(async (number: string) =>
        number === order.orderNumber ? order.id : null,
      ),
    resolveCatalogPage: vi.fn().mockResolvedValue(null),
    catalog: {
      mainMenu,
      categoryList: vi.fn(),
      categoryView: vi.fn(),
      variantDetail: vi.fn(),
      search: vi.fn(),
    },
    checkout: {
      buyNowFromCallback: vi.fn(),
      refresh,
      reopen: vi.fn(),
      cancel: vi.fn(),
    },
    history: { list: vi.fn(), detail: vi.fn() },
    support: { reasonMenu: vi.fn(), open: vi.fn(), list: vi.fn() },
    responder: { send },
  });
  return { codec, dispatcher, mainMenu, refresh, send, order };
}

describe("durable Telegram envelope to domain dispatcher (T129)", () => {
  it("routes a signed customer-scoped payment action and reseals every response button", async () => {
    const { codec, dispatcher, refresh, send, order } = setup();
    const callbackData = codec.issue({
      action: "PAYMENT_REFRESH",
      resourceId: order.id,
      telegramUserId: USER,
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "10",
      action: "PAYMENT_CHECK",
      callbackData,
    });

    expect(refresh).toHaveBeenCalledWith(order.orderNumber, CUSTOMER);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.message.buttons[0]![0]!.callbackData).toMatch(/^cb:/);
    expect(sent.message.buttons[0]![0]!.callbackData).not.toContain(order.orderNumber);
  });

  it("routes commands and rejects a token copied to a different Telegram user", async () => {
    const { codec, dispatcher, mainMenu, refresh, order } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "11",
      action: "CATALOG",
      command: "/start",
    });
    expect(mainMenu).toHaveBeenCalledTimes(1);

    const stolen = codec.issue({
      action: "PAYMENT_REFRESH",
      resourceId: order.id,
      telegramUserId: USER,
    });
    await dispatcher.handle({
      actorUserId: "999999999",
      chatId: "999999999",
      chatType: "private",
      messageId: "12",
      action: "PAYMENT_CHECK",
      callbackData: stolen,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
