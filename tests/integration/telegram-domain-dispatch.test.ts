import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { TelegramCommandEnvelope } from "../../src/infrastructure/inbox/telegram.js";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import { registerTelegramWebhook } from "../../src/bot/webhook.js";
import {
  presentAdminInventoryMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductsMenu,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
} from "../../src/bot/presenters/admin.js";
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
  const adminMainMenu = vi.fn().mockResolvedValue(presentAdminMenu());
  const adminDashboard = vi.fn().mockResolvedValue({
    text: "dashboard",
    buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
  });
  const adminProducts = vi.fn().mockResolvedValue({
    text: "products",
    buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
  });
  const adminProductDetail = vi.fn().mockResolvedValue({
    text: "product detail",
    buttons: [[{ text: "↩️ Quay lại", callbackData: "admin:products" }]],
  });
  const adminInventory = vi.fn().mockResolvedValue({
    text: "inventory",
    buttons: [[{ text: "📊 Tổng quan", callbackData: "admin:dashboard" }]],
  });
  const workflowMessageText = vi.fn().mockResolvedValue({
    text: "workflow",
    buttons: [[{ text: "cancel", callbackData: "admin:products:cancel" }]],
  });
  const workflowCancel = vi.fn().mockResolvedValue({
    text: "cancelled",
    buttons: [[{ text: "Products", callbackData: "admin:products" }]],
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
  const walletTopup = vi.fn().mockResolvedValue({ text: "wallet topup", buttons: [] });
  const walletPay = vi.fn().mockResolvedValue({ text: "wallet pay", buttons: [] });
  const presentAdminCustomerDetail = vi.fn().mockResolvedValue({ text: "customer detail", buttons: [] });
  const sendAdminCustomerMessage = vi.fn().mockResolvedValue({ text: "message sent", buttons: [] });
  const adminConfirm = vi.fn().mockResolvedValue({ text: "confirmed", buttons: [] });
  const broadcastCompose = vi.fn().mockResolvedValue({ text: "choose audience", buttons: [] });
  const broadcastAudience = vi.fn().mockResolvedValue({ text: "compose", buttons: [] });
  const broadcastText = vi.fn().mockResolvedValue(null);
  const broadcastConfirm = vi.fn().mockResolvedValue({ text: "status", buttons: [] });
  const broadcastCancel = vi.fn().mockResolvedValue({ text: "cancelled", buttons: [] });
  const broadcastStatus = vi.fn().mockResolvedValue({ text: "status", buttons: [] });
  const supportReasonMenu = vi.fn().mockReturnValue({ text: "support menu", buttons: [] });

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
    support: { reasonMenu: supportReasonMenu, open: vi.fn(), list: vi.fn() },
    walletTopup,
    walletPay,
    admin: {
      handleToken: vi.fn().mockResolvedValue({
        text: "token",
        buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
      }),
      mainMenu: adminMainMenu,
      dashboard: adminDashboard,
      products: adminProducts,
      productDetail: adminProductDetail,
      inventory: adminInventory,
      presentAdminCustomerDetail,
      sendAdminCustomerMessage,
      confirm: adminConfirm,
      importPreview: vi.fn(),
      importConfirm: vi.fn(),
      importCancel: vi.fn(),
      marketing: vi.fn().mockResolvedValue({ text: "marketing", buttons: [] }),
      broadcastCompose,
      broadcastAudience,
      broadcastText,
      broadcastConfirm,
      broadcastCancel,
      broadcastStatus,
      workflow: {
        messageText: workflowMessageText,
        start: vi.fn().mockResolvedValue({ text: "start", buttons: [] }),
        category: vi.fn(),
        confirm: vi.fn(),
        cancel: workflowCancel,
      },
    },
    responder: { send },
  });

  return {
    codec,
    dispatcher,
    mainMenu,
    adminMainMenu,
    adminDashboard,
    adminProducts,
    adminProductDetail,
    adminInventory,
    workflowMessageText,
    workflowCancel,
    refresh,
    walletTopup,
    walletPay,
    presentAdminCustomerDetail,
    sendAdminCustomerMessage,
    adminConfirm,
    broadcastCompose,
    broadcastAudience,
    broadcastText,
    broadcastConfirm,
    broadcastCancel,
    broadcastStatus,
    supportReasonMenu,
    send,
    order,
  };
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

  it("routes /start to the persistent customer home once even when admin workflow exists", async () => {
    const { dispatcher, workflowMessageText, send } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "11",
      action: "CATALOG",
      command: "/start",
    });
    expect(workflowMessageText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("SHOP DIGITAL");
  });

  it("routes the customer account reply keyboard label to the account prompt", async () => {
    const { dispatcher, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "14",
      action: "CATALOG",
      messageText: "👤 Tài khoản",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("Chia sẻ số điện thoại");
  });

  it("routes the customer topup reply keyboard label through Telegram normalization to wallet topup", async () => {
    const { dispatcher, walletTopup, mainMenu, send } = setup();
    const app = Fastify();
    const inbox = {
      accept: vi.fn(async (input: { envelope: TelegramCommandEnvelope }) => {
        await dispatcher.handle(input.envelope);
        return { kind: "ACCEPTED" as const, id: "memory:test" };
      }),
    };
    await registerTelegramWebhook(app, { path: "/telegram", secretToken: "secret", inbox });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/telegram",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      payload: {
        update_id: 504,
        message: {
          message_id: 504,
          from: { id: Number(USER), is_bot: false },
          chat: { id: Number(USER), type: "private" },
          text: "💰 Nạp ví",
        },
      },
    });

    expect(walletTopup).toHaveBeenCalledTimes(1);
    expect(mainMenu).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: { text: "wallet topup", buttons: [] } }));
    await app.close();
  });

  it("routes the customer back reply keyboard label to the home screen", async () => {
    const { dispatcher, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "15",
      action: "CATALOG",
      messageText: "↩️ Quay lại",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("Chọn tác vụ phía dưới");
  });

  it("routes /admin to the Vietnamese admin root menu with inline keyboard", async () => {
    const { dispatcher, adminMainMenu, send } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "12",
      action: "ADMIN",
      command: "/admin",
    });
    expect(adminMainMenu).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as {
      message: { text: string; buttons: Array<Array<{ text: string }>> };
    };
    expect(sent.message.text).toContain("BẢNG");
    const labels = sent.message.buttons.flat().map((button) => button.text);
    expect(labels).toEqual(expect.arrayContaining(["🛍 Sản phẩm", "📦 Kho hàng", "🧾 Đơn hàng"]));
    expect(labels).not.toEqual(
      expect.arrayContaining(["Dashboard", "Products", "Inventory", "📊 Tổng quan"]),
    );
  });

  it("routes the live visible products callback to the injected products presenter", async () => {
    const { dispatcher, adminProducts, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "13",
      action: "ADMIN",
      callbackData: "admin:products",
    });

    expect(adminProducts).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as {
      message: { text: string; buttons: Array<Array<{ text: string }>> };
    };
    expect(sent.message.text).toContain("products");
  });

  it("routes the live visible product detail callback to the injected product detail presenter", async () => {
    const { dispatcher, adminProductDetail, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "13b",
      action: "ADMIN",
      callbackData: `admin:products:detail:${newId()}`,
    });

    expect(adminProductDetail).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("product detail");
  });

  it("routes the live visible dashboard callback to the injected dashboard presenter", async () => {
    const { dispatcher, adminDashboard, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "13a",
      action: "ADMIN",
      callbackData: "admin:dashboard",
    });

    expect(adminDashboard).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("dashboard");
  });

  it("routes the live visible admin callbacks without placeholder text", async () => {
    const visibleMessages = [
      presentAdminMenu(),
      presentAdminProductsMenu(),
      presentAdminInventoryMenu(),
      presentAdminOrdersMenu(),
      presentAdminPaymentsMenu(),
      presentAdminSuppliersMenu(),
      presentAdminSupportMenu(),
    ];
    const callbacks = [
      ...new Set(
        visibleMessages.flatMap((message) =>
          message.buttons.flat().map((button) => button.callbackData),
        ),
      ),
    ];
    const { dispatcher, send } = setup();

    for (const [index, callbackData] of callbacks.entries()) {
      await dispatcher.handle({
        actorUserId: USER,
        chatId: USER,
        chatType: "private",
        messageId: `admin-route-${index}`,
        action: "ADMIN",
        callbackData,
      });
    }

    expect(send).toHaveBeenCalledTimes(callbacks.length);
    for (const call of send.mock.calls) {
      const message = call[0].message;
      expect(message.text).not.toMatch(/đang hoàn thiện|không khả dụng|không được hỗ trợ/i);
      expect(message.text.trim()).not.toBe("");
    }
  });

  it("routes plain text to active workflow before storefront fallback", async () => {
    const { dispatcher, workflowMessageText, mainMenu } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "14",
      action: "UNKNOWN",
      messageText: "hello",
    });
    expect(workflowMessageText).toHaveBeenCalledTimes(1);
    expect(mainMenu).not.toHaveBeenCalled();
  });
  it("routes inventory import text before the generic workflow when present", async () => {
    const base = setup();
    const importText = vi.fn().mockResolvedValue({
      text: "import preview",
      buttons: [[{ text: "confirm", callbackData: "admin:inventory:confirm" }]],
    });
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderById: vi.fn(),
      resolveOrderIdByNumber: vi.fn(),
      resolveCatalogPage: vi.fn().mockResolvedValue(null),
      catalog: {
        mainMenu: base.mainMenu,
        categoryList: vi.fn(),
        categoryView: vi.fn(),
        variantDetail: vi.fn(),
        search: vi.fn(),
      },
      checkout: {
        buyNowFromCallback: vi.fn(),
        refresh: vi.fn(),
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: { list: vi.fn(), detail: vi.fn() },
      support: { reasonMenu: vi.fn(), open: vi.fn(), list: vi.fn() },
      admin: {
        handleToken: vi.fn().mockResolvedValue({ text: "token", buttons: [] }),
        mainMenu: base.adminMainMenu,
        dashboard: base.adminDashboard,
        products: base.adminProducts,
        productDetail: base.adminProductDetail,
        inventory: base.adminInventory,
        importPreview: vi.fn(),
        importConfirm: vi.fn(),
        importCancel: vi.fn(),
        importText,
        workflow: {
          messageText: base.workflowMessageText,
          start: vi.fn().mockResolvedValue({ text: "start", buttons: [] }),
          category: vi.fn(),
          confirm: vi.fn(),
          cancel: base.workflowCancel,
        },
      },
      responder: { send: base.send },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "14a",
      action: "UNKNOWN",
      messageText: "variant-a,secret",
    });

    expect(importText).toHaveBeenCalledTimes(1);
    expect(base.workflowMessageText).not.toHaveBeenCalled();
    expect(base.send).toHaveBeenCalledTimes(1);
    expect(base.send.mock.calls[0]![0].message.text).toBe("import preview");
  });

  it("lets /cancel win over active workflow text", async () => {
    const { dispatcher, workflowCancel, workflowMessageText } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "15",
      action: "CANCEL",
      command: "/cancel",
      messageText: "/cancel",
    });
    expect(workflowCancel).toHaveBeenCalledTimes(1);
    expect(workflowMessageText).not.toHaveBeenCalled();
  });

  it("routes /confirm text into the admin confirmation handler", async () => {
    const { dispatcher, adminConfirm, send } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "confirm-1",
      action: "ADMIN",
      command: "/confirm",
      searchQuery: "01HZZZZZZZZZZZZZZZZZZZZZZZ abc123",
    });

    expect(adminConfirm).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      confirmationId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      challenge: "abc123",
      correlationId: "telegram:confirm-1",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: { text: "confirmed", buttons: [] } }));
  });

  it("normalizes Telegram /customer and /message_customer updates into admin handlers", async () => {
    const { dispatcher, presentAdminCustomerDetail, sendAdminCustomerMessage } = setup();
    const app = Fastify();
    const inbox = {
      accept: vi.fn(async (input: { envelope: TelegramCommandEnvelope }) => {
        await dispatcher.handle(input.envelope);
        return { kind: "ACCEPTED" as const, id: "memory:test" };
      }),
    };
    await registerTelegramWebhook(app, { path: "/telegram", secretToken: "secret", inbox });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/telegram",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      payload: {
        update_id: 501,
        message: {
          message_id: 501,
          from: { id: Number(USER), is_bot: false },
          chat: { id: Number(USER), type: "private" },
          text: "/customer cust-1",
          entities: [{ type: "bot_command", offset: 0, length: 9 }],
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/telegram",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      payload: {
        update_id: 502,
        message: {
          message_id: 502,
          from: { id: Number(USER), is_bot: false },
          chat: { id: Number(USER), type: "private" },
          text: "/message_customer cust-1 Xin chào",
          entities: [{ type: "bot_command", offset: 0, length: 17 }],
        },
      },
    });

    expect(presentAdminCustomerDetail).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: USER, chatType: "private" }),
      "cust-1",
    );
    expect(sendAdminCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: USER, chatType: "private" }),
      { customerId: "cust-1", text: "Xin chào" },
    );
    await app.close();
  });

  it("drops non-private Telegram updates before dispatch", async () => {
    const { dispatcher, send } = setup();
    const app = Fastify();
    const inbox = {
      accept: vi.fn(async (input: { envelope: TelegramCommandEnvelope }) => {
        await dispatcher.handle(input.envelope);
        return { kind: "ACCEPTED" as const, id: "memory:test" };
      }),
    };
    await registerTelegramWebhook(app, { path: "/telegram", secretToken: "secret", inbox });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/telegram",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      payload: {
        update_id: 503,
        message: {
          message_id: 503,
          from: { id: Number(USER), is_bot: false },
          chat: { id: -100, type: "group" },
          text: "/admin",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(inbox.accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });

  it("routes wallet commands and leaves support routed to support", async () => {
    const { dispatcher, walletTopup, walletPay, supportReasonMenu } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "wallet-topup",
      action: "WALLET",
      callbackData: "wallet:topup",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "wallet-pay",
      action: "WALLET",
      command: "/pay",
      searchQuery: "ORD-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "support",
      action: "SUPPORT",
      command: "/support",
    });

    expect(walletTopup).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: USER }));
    expect(walletPay).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: USER }), "ORD-1");
    expect(supportReasonMenu).toHaveBeenCalledTimes(1);
    expect(walletTopup).toHaveBeenCalledTimes(1);
    expect(walletPay).toHaveBeenCalledTimes(1);
  });

  it("routes the marketing broadcast compose, root-safe preview, confirm, status, and cancel flow", async () => {
    const { dispatcher, send, broadcastCompose, broadcastAudience, broadcastText, broadcastConfirm, broadcastStatus, broadcastCancel } = setup();
    broadcastText.mockResolvedValue({ text: "preview", buttons: [] });

    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m1", action: "ADMIN", callbackData: "admin:marketing:compose" });
    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m2", action: "ADMIN", callbackData: "admin:marketing:audience:root" });
    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m3", action: "UNKNOWN", messageText: "Hello root" });
    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m4", action: "ADMIN", callbackData: "admin:marketing:confirm:campaign-1" });
    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m5", action: "ADMIN", callbackData: "admin:marketing:status:campaign-1" });
    await dispatcher.handle({ actorUserId: USER, chatId: USER, chatType: "private", messageId: "m6", action: "ADMIN", callbackData: "admin:marketing:cancel:campaign-1" });

    expect(broadcastCompose).toHaveBeenCalledTimes(1);
    expect(broadcastAudience).toHaveBeenCalledWith(expect.objectContaining({ audience: "root" }));
    expect(broadcastText).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello root" }));
    expect(broadcastConfirm).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "campaign-1" }));
    expect(broadcastStatus).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "campaign-1" }));
    expect(broadcastCancel).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "campaign-1" }));
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("rejects a token copied to a different Telegram user", async () => {
    const { codec, dispatcher, adminMainMenu, refresh, order } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "11",
      action: "CATALOG",
      command: "/start",
    });
    expect(adminMainMenu).not.toHaveBeenCalled();

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
