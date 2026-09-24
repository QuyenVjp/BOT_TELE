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
  const categoryList = vi.fn().mockResolvedValue({
    text: "categories",
    buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
  });
  const categoryView = vi.fn().mockResolvedValue({
    text: "category page",
    buttons: [[{ text: "Quay lại", callbackData: "cat:list" }]],
  });
  const catalogSearch = vi.fn();
  const storefront = vi.fn().mockResolvedValue({
    text: "TIER20 SHOP home",
    buttons: [[{ text: "🤖 AI", callbackData: "cat:view:1" }]],
  });
  const adminMainMenu = vi.fn().mockResolvedValue(presentAdminMenu());
  const adminDashboard = vi.fn().mockResolvedValue({
    text: "dashboard",
    buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
  });
  const adminOperations = vi.fn().mockResolvedValue({
    text: "operations readiness",
    buttons: [[{ text: "⚙️ Quản trị", callbackData: "admin:menu" }]],
  });
  const adminAudit = vi.fn().mockResolvedValue({
    text: "audit",
    buttons: [[{ text: "📦 Kho hàng", callbackData: "admin:inventory" }]],
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
  // The owner's warranty surface: the queue, a view switch, the payout queue and one claim.
  const warrantyQueue = vi.fn().mockResolvedValue({
    text: "warranty queue",
    buttons: [[{ text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" }]],
  });
  const warrantyRefundQueue = vi.fn().mockResolvedValue({
    text: "refund queue",
    buttons: [[{ text: "🛡 Danh sách bảo hành", callbackData: "admin:warranty" }]],
  });
  const warrantyClaim = vi.fn().mockResolvedValue({
    text: "claim",
    buttons: [[{ text: "✅ Xác nhận lỗi", callbackData: "admin:warranty:verify:CLAIM-1" }]],
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
  const ack = vi.fn().mockResolvedValue(undefined);
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const walletTopup = vi.fn().mockResolvedValue({ text: "wallet topup", buttons: [] });
  const walletTopupText = vi.fn().mockResolvedValue(null);
  const walletPay = vi.fn().mockResolvedValue({ text: "wallet pay", buttons: [] });
  const presentAdminCustomerDetail = vi
    .fn()
    .mockResolvedValue({ text: "customer detail", buttons: [] });
  const sendAdminCustomerMessage = vi.fn().mockResolvedValue({ text: "message sent", buttons: [] });
  const adminConfirm = vi.fn().mockResolvedValue({ text: "confirmed", buttons: [] });
  const broadcastCompose = vi.fn().mockResolvedValue({ text: "choose audience", buttons: [] });
  const broadcastAudience = vi.fn().mockResolvedValue({ text: "compose", buttons: [] });
  const broadcastText = vi.fn().mockResolvedValue(null);
  const ownerPromptText = vi.fn().mockResolvedValue({ text: "owner prompt handled", buttons: [] });
  const broadcastConfirm = vi.fn().mockResolvedValue({ text: "status", buttons: [] });
  const broadcastCancel = vi.fn().mockResolvedValue({ text: "cancelled", buttons: [] });
  const broadcastStatus = vi.fn().mockResolvedValue({ text: "status", buttons: [] });
  const adminCustomers = vi.fn().mockResolvedValue({ text: "customers", buttons: [] });
  const adminCustomerState = vi.fn().mockResolvedValue({ text: "customer state", buttons: [] });
  const adminCustomerSearch = vi.fn().mockResolvedValue({ text: "customer search", buttons: [] });
  const adminCustomerMessagePrompt = vi
    .fn()
    .mockResolvedValue({ text: "message prompt", buttons: [] });
  const adminOrders = vi.fn().mockResolvedValue({ text: "orders", buttons: [] });
  const adminOrderState = vi.fn().mockResolvedValue({ text: "order state", buttons: [] });
  const adminOrderSearch = vi.fn().mockResolvedValue({ text: "order search", buttons: [] });
  const adminOrderMessagePrompt = vi.fn().mockResolvedValue({ text: "order message", buttons: [] });
  const adminOrderText = vi.fn().mockResolvedValue(null);
  const adminManualTasks = vi.fn().mockResolvedValue({ text: "manual tasks", buttons: [] });
  const adminManualTask = vi.fn().mockResolvedValue({
    text: "manual detail",
    buttons: [[{ text: "confirm", callbackData: "admin:manual:complete:state-1" }]],
  });
  const adminManualComplete = vi.fn().mockResolvedValue({ text: "challenge", buttons: [] });
  const adminCustomerText = vi.fn().mockResolvedValue(null);
  const importDocument = vi.fn().mockResolvedValue({
    text: "file preview",
    buttons: [[{ text: "activate", callbackData: "admin:inventory:file-confirm:state-1" }]],
  });
  const importFileConfirm = vi.fn().mockResolvedValue({ text: "file activated", buttons: [] });
  const importTemplate = vi.fn().mockResolvedValue({ text: "csv template", buttons: [] });
  const quantityAdjustPreview = vi.fn().mockResolvedValue({ text: "qty preview", buttons: [] });
  const quantityAdjustConfirm = vi.fn().mockResolvedValue({ text: "qty done", buttons: [] });
  const quantityAdjustText = vi.fn().mockResolvedValue(null);
  const stockAnnouncementPreview = vi
    .fn()
    .mockResolvedValue({ text: "stock preview", buttons: [] });
  const adminVariantCreatePrompt = vi
    .fn()
    .mockResolvedValue({ text: "variant create", buttons: [] });
  const adminVariantEditPrompt = vi.fn().mockResolvedValue({ text: "variant edit", buttons: [] });
  const adminVariantEditField = vi.fn().mockResolvedValue({ text: "variant field", buttons: [] });
  const adminPaymentsView = vi.fn().mockResolvedValue({ text: "payment queue", buttons: [] });
  const adminVariantEditToggle = vi
    .fn()
    .mockResolvedValue({ text: "variant toggled", buttons: [] });
  const workflowVariantText = vi.fn().mockResolvedValue(null);
  const visibilityAction = vi.fn().mockResolvedValue({ text: "visibility step", buttons: [] });
  const supportReasonMenu = vi.fn().mockReturnValue({ text: "support menu", buttons: [] });
  const adminSupport = vi.fn().mockResolvedValue({ text: "support queue", buttons: [] });
  const adminSupportApprove = vi
    .fn()
    .mockResolvedValue({ text: "replacement challenge", buttons: [] });
  const notificationSettings = vi
    .fn()
    .mockResolvedValue({ text: "notification settings", buttons: [] });
  const notificationToggle = vi.fn().mockResolvedValue({ text: "toggled", buttons: [] });
  const notificationSubscriptions = vi
    .fn()
    .mockResolvedValue({ text: "subscriptions", buttons: [] });
  const restockSubscribe = vi.fn().mockResolvedValue({ text: "subscribed", buttons: [] });
  const restockUnsubscribe = vi.fn().mockResolvedValue({ text: "unsubscribed", buttons: [] });
  const restockList = vi.fn().mockResolvedValue({ text: "restock list", buttons: [] });
  const preorderConsent = vi.fn().mockResolvedValue({ text: "preorder consent", buttons: [] });
  const preorderCreate = vi.fn().mockResolvedValue({ text: "preorder deposit qr", buttons: [] });
  const preorderPay = vi.fn().mockResolvedValue({ text: "preorder deposit qr", buttons: [] });
  const preorderList = vi.fn().mockResolvedValue({ text: "preorder list", buttons: [] });
  const trustPage = vi.fn().mockResolvedValue({ text: "trust", buttons: [] });

  const dispatcher = createTelegramDomainDispatcher({
    codec,
    resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
    resolveOrderByIdForOwner: vi
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
      categoryList,
      categoryView,
      variantDetail: vi.fn(),
      search: catalogSearch,
      storefront,
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
    walletTopupText,
    walletPay,
    notification: {
      settings: notificationSettings,
      toggle: notificationToggle,
      subscriptions: notificationSubscriptions,
    },
    restock: {
      subscribe: restockSubscribe,
      unsubscribe: restockUnsubscribe,
      list: restockList,
    },
    admin: {
      handleToken: vi.fn().mockResolvedValue({
        text: "token",
        buttons: [[{ text: "🛍 Sản phẩm", callbackData: "admin:products" }]],
      }),
      mainMenu: adminMainMenu,
      dashboard: adminDashboard,
      operations: adminOperations,
      audit: adminAudit,
      products: adminProducts,
      productDetail: adminProductDetail,
      variantCreatePrompt: adminVariantCreatePrompt,
      variantEditPrompt: adminVariantEditPrompt,
      paymentsView: adminPaymentsView,
      variantEditField: adminVariantEditField,
      variantEditToggle: adminVariantEditToggle,
      inventory: adminInventory,
      warrantyQueue,
      warrantyRefundQueue,
      warrantyClaim,
      stockAnnouncementPreview,
      customers: adminCustomers,
      customerState: adminCustomerState,
      customerSearch: adminCustomerSearch,
      customerMessagePrompt: adminCustomerMessagePrompt,
      customerText: adminCustomerText,
      orders: adminOrders,
      orderState: adminOrderState,
      orderSearch: adminOrderSearch,
      orderMessagePrompt: adminOrderMessagePrompt,
      orderText: adminOrderText,
      presentAdminCustomerDetail,
      sendAdminCustomerMessage,
      confirm: adminConfirm,
      manualTasks: adminManualTasks,
      manualTask: adminManualTask,
      manualComplete: adminManualComplete,
      support: adminSupport,
      supportApprove: adminSupportApprove,
      categories: vi.fn().mockResolvedValue({ text: "categories", buttons: [] }),
      preorders: vi.fn().mockResolvedValue({ text: "preorders", buttons: [] }),
      testLab: vi.fn().mockResolvedValue({ text: "test lab", buttons: [] }),
      importPreview: vi.fn(),
      importConfirm: vi.fn(),
      importCancel: vi.fn(),
      importDocument,
      importFileConfirm,
      importTemplate,
      quantityAdjustPreview,
      quantityAdjustConfirm,
      quantityAdjustText,
      marketing: vi.fn().mockResolvedValue({ text: "marketing", buttons: [] }),
      broadcastCompose,
      broadcastAudience,
      broadcastText,
      ownerPromptText,
      broadcastConfirm,
      broadcastCancel,
      broadcastStatus,
      health: vi.fn().mockResolvedValue({ text: "health", buttons: [] }),
      notifications: vi.fn().mockResolvedValue({ text: "notifications", buttons: [] }),
      storeOpen: vi.fn().mockResolvedValue({ text: "store open", buttons: [] }),
      storeClose: vi.fn().mockResolvedValue({ text: "store close", buttons: [] }),
      workflow: {
        variantText: workflowVariantText,
        messageText: workflowMessageText,
        start: vi.fn().mockResolvedValue({ text: "start", buttons: [] }),
        category: vi.fn(),
        confirm: vi.fn(),
        cancel: workflowCancel,
        visibilityAction,
      },
    },
    preorder: {
      consent: preorderConsent,
      create: preorderCreate,
      pay: preorderPay,
      list: preorderList,
    },
    trust: { page: trustPage },
    responder: { send, deleteMessage, ack },
  });

  return {
    codec,
    dispatcher,
    catalogSearch,
    storefront,
    mainMenu,
    categoryList,
    categoryView,
    adminMainMenu,
    adminDashboard,
    adminAudit,
    adminProducts,
    adminProductDetail,
    adminInventory,
    warrantyQueue,
    warrantyRefundQueue,
    warrantyClaim,
    workflowMessageText,
    workflowCancel,
    refresh,
    walletTopup,
    walletTopupText,
    walletPay,
    presentAdminCustomerDetail,
    sendAdminCustomerMessage,
    adminConfirm,
    broadcastCompose,
    broadcastAudience,
    broadcastText,
    ownerPromptText,
    broadcastConfirm,
    broadcastCancel,
    broadcastStatus,
    adminCustomers,
    adminCustomerState,
    adminVariantCreatePrompt,
    adminVariantEditPrompt,
    adminVariantEditField,
    adminVariantEditToggle,
    adminPaymentsView,
    workflowVariantText,
    adminCustomerSearch,
    adminCustomerMessagePrompt,
    adminOrders,
    adminOrderState,
    adminOrderSearch,
    adminOrderMessagePrompt,
    adminOrderText,
    importTemplate,
    adminCustomerText,
    adminManualTasks,
    adminManualTask,
    adminManualComplete,
    adminSupport,
    adminSupportApprove,
    importDocument,
    importFileConfirm,
    quantityAdjustPreview,
    quantityAdjustConfirm,
    quantityAdjustText,
    stockAnnouncementPreview,
    supportReasonMenu,
    notificationSettings,
    notificationToggle,
    notificationSubscriptions,
    restockSubscribe,
    restockUnsubscribe,
    restockList,
    deleteMessage,
    send,
    ack,
    trustPage,
    order,
    visibilityAction,
    preorderConsent,
    preorderCreate,
    preorderPay,
    preorderList,
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

    expect(refresh).toHaveBeenCalledWith(order.orderNumber, CUSTOMER, {
      telegramUserId: USER,
      isRootAdmin: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.message.buttons[0]![0]!.callbackData).toMatch(/^cb:/);
    expect(sent.message.buttons[0]![0]!.callbackData).not.toContain(order.orderNumber);
  });
  it("acknowledges every trust callback before rendering the trust page", async () => {
    const { dispatcher, ack, trustPage, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "trust-message",
      action: "UNKNOWN",
      callbackData: "trust:page:2",
      callbackQueryId: "trust-callback-2",
    });

    expect(ack).toHaveBeenCalledWith("trust-callback-2");
    expect(trustPage).toHaveBeenCalledWith(CUSTOMER, 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deletes the credential message after the customer acknowledges it", async () => {
    const { dispatcher, deleteMessage, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "42",
      action: "UNKNOWN",
      callbackData: "delivery:delete",
      callbackQueryId: "delivery-delete",
    });

    expect(deleteMessage).toHaveBeenCalledWith(USER, 42);
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks retired wallet preset selection from the customer dispatcher", async () => {
    const { dispatcher, walletTopup, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "10",
      action: "WALLET",
      callbackData: "wallet:topup:amount:200000",
    });

    expect(walletTopup).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as { message: { text: string } }).message.text).toContain(
      "retail MVP",
    );
  });

  it("routes an unclaimed customer query to catalog search instead of the home screen", async () => {
    // Regression: the admin/wallet text handlers are always wired in production, so the
    // fallthrough used to send every typed query to the home screen and the free-text search
    // router (the final `else`) was unreachable. In production every admin text handler returns
    // null unless the ROOT actor is inside that flow, so make the harness models do the same.
    const {
      dispatcher,
      catalogSearch,
      storefront,
      send,
      workflowMessageText,
      importDocument,
      quantityAdjustText,
      broadcastText,
      walletTopupText,
    } = setup();
    for (const mock of [
      workflowMessageText,
      importDocument,
      quantityAdjustText,
      broadcastText,
      walletTopupText,
    ]) {
      mock.mockResolvedValue(null);
    }
    catalogSearch.mockResolvedValueOnce({ text: "kết quả tìm kiếm", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "9b",
      action: "CATALOG",
      messageText: "claude",
    });

    expect(catalogSearch).toHaveBeenCalledTimes(1);
    expect(catalogSearch.mock.calls[0]![0]).toBe("claude");
    expect(storefront).not.toHaveBeenCalled();
    const sent = send.mock.calls.at(-1)![0] as { message: { text: string } };
    expect(sent.message.text).toContain("kết quả tìm kiếm");
  });

  it("routes custom wallet topup text before admin text handlers", async () => {
    const { dispatcher, walletTopupText, workflowMessageText, send } = setup();
    walletTopupText.mockResolvedValueOnce({ text: "confirm 375000", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "10",
      action: "UNKNOWN",
      messageText: "375.000",
    });

    expect(walletTopupText).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: USER }),
      "375.000",
    );
    expect(workflowMessageText).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0].message.text).toBe("confirm 375000");
  });

  it("blocks retired wallet topup status and cancellation callbacks", async () => {
    const { dispatcher, walletTopup, send } = setup();

    for (const callbackData of ["wallet:topup:status", "wallet:topup:cancel"]) {
      await dispatcher.handle({
        actorUserId: USER,
        chatId: USER,
        chatType: "private",
        messageId: "10",
        action: "WALLET",
        callbackData,
      });
    }

    expect(walletTopup).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every((call) =>
        (call[0] as { message: { text: string } }).message.text.includes("retail MVP"),
      ),
    ).toBe(true);
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
    expect(sent.message.text).toContain("TIER20 SHOP");
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

  it("does not route the retired customer topup label to wallet operations", async () => {
    const { dispatcher, walletTopup, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "15",
      action: "UNKNOWN",
      messageText: "💰 Nạp ví",
    });

    expect(walletTopup).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { message: { text: string } };
    expect(sent.message.text).toContain("retail MVP");
  });
  it("routes visible notification reply labels to their existing toggles", async () => {
    const { dispatcher, notificationToggle, send } = setup();

    for (const [messageText, kind] of [
      ["🛍 Cập nhật sản phẩm", "shop"],
      ["📣 Hoạt động mua hàng", "activity"],
    ] as const) {
      await dispatcher.handle({
        actorUserId: USER,
        chatId: USER,
        chatType: "private",
        messageId: `toggle-${kind}`,
        action: "UNKNOWN",
        messageText,
      });
    }

    expect(notificationToggle).toHaveBeenNthCalledWith(1, CUSTOMER, "shop");
    expect(notificationToggle).toHaveBeenNthCalledWith(2, CUSTOMER, "activity");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("routes signed restock subscribe and unsubscribe callbacks for the actor only", async () => {
    const { codec, dispatcher, restockSubscribe, restockUnsubscribe, send } = setup();
    const variantId = newId();
    const subscribe = codec.issue({
      action: "RESTOCK_SUBSCRIBE",
      resourceId: variantId,
      telegramUserId: USER,
    });
    const unsubscribe = codec.issue({
      action: "RESTOCK_UNSUBSCRIBE",
      resourceId: variantId,
      telegramUserId: USER,
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "restock-subscribe",
      action: "UNKNOWN",
      callbackData: subscribe,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "restock-unsubscribe",
      action: "UNKNOWN",
      callbackData: unsubscribe,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "restock-tampered",
      action: "UNKNOWN",
      callbackData: subscribe.slice(0, -1) + (subscribe.endsWith("A") ? "B" : "A"),
    });

    expect(restockSubscribe).toHaveBeenCalledWith(CUSTOMER, variantId);
    expect(restockSubscribe).toHaveBeenCalledTimes(1);
    expect(restockUnsubscribe).toHaveBeenCalledWith(CUSTOMER, variantId);
    expect(restockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(-1)![0].message.text).toContain("Phiên này đã cũ");
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
    expect(sent.message.text).toContain("TIER20 SHOP");
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
    expect(sent.message.text).toContain("Quản trị");
    const labels = sent.message.buttons.flat().map((button) => button.text);
    expect(labels).toEqual(expect.arrayContaining(["📦 Sản phẩm", "📥 Kho hàng", "🧾 Đơn hàng"]));
    expect(labels).not.toEqual(expect.arrayContaining(["Dashboard", "Products", "Inventory"]));
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

  it("routes manual fulfillment callbacks through list, detail, and confirmation request", async () => {
    const { dispatcher, adminManualTasks, adminManualTask, adminManualComplete, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "manual-1",
      action: "ADMIN",
      callbackData: "admin:manual",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "manual-2",
      action: "ADMIN",
      callbackData: "admin:manual:view:task-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "manual-3",
      action: "ADMIN",
      callbackData: "admin:manual:complete:state-1",
    });

    expect(adminManualTasks).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:manual-1",
    });
    expect(adminManualTask).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      taskId: "task-1",
      correlationId: "telegram:manual-2",
    });
    expect(adminManualComplete).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      stateId: "state-1",
      correlationId: "telegram:manual-3",
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("parses the product list's filter and page out of the route", async () => {
    const { dispatcher, adminProducts } = setup();

    // The route family is `products:view:<view>[:<page>]` and it is matched before the plain
    // `products` branch, so a mis-indexed split silently shows the wrong list. Pin both shapes.
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "products-view-1",
      action: "ADMIN",
      callbackData: "admin:products:view:test:2",
    });
    expect(adminProducts).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "test", page: 2 }),
    );

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "products-view-2",
      action: "ADMIN",
      callbackData: "admin:products:view",
    });
    expect(adminProducts).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "all", page: 1 }),
    );
  });

  it("routes admin support queue and replacement approval callbacks", async () => {
    const { dispatcher, adminSupport, adminSupportApprove, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "support-list",
      action: "ADMIN",
      callbackData: "admin:support",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "support-approve",
      action: "ADMIN",
      callbackData: "admin:support:approve:case-1",
    });

    expect(adminSupport).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:support-list",
    });
    expect(adminSupportApprove).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      caseId: "case-1",
      correlationId: "telegram:support-approve",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("routes independent product variant create and edit callbacks", async () => {
    const {
      dispatcher,
      adminVariantCreatePrompt,
      adminVariantEditPrompt,
      adminVariantEditField,
      adminVariantEditToggle,
      send,
    } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "variant-add",
      action: "ADMIN",
      callbackData: "admin:products:variant-add:product-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "variant-edit",
      action: "ADMIN",
      callbackData: "admin:products:variant-edit:variant-1",
    });

    expect(adminVariantCreatePrompt).toHaveBeenCalledWith({
      telegramUserId: USER,
      productId: "product-1",
      chatType: "private",
      correlationId: "telegram:variant-add",
    });
    expect(adminVariantEditPrompt).toHaveBeenCalledWith({
      telegramUserId: USER,
      variantId: "variant-1",
      chatType: "private",
      correlationId: "telegram:variant-edit",
    });

    // Goal §78/§172. The route carries the field key alone: Telegram caps callback data at 64 bytes,
    // and the first cut of this (`variant-field:<id>:<key>`) overflowed for three of the five fields,
    // which the ingress drops without a word. A route with no id in it cannot grow past the cap.
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "variant-field",
      action: "ADMIN",
      callbackData: "admin:products:vf:priceVnd",
    });
    expect(adminVariantEditField).toHaveBeenCalledWith({
      telegramUserId: USER,
      fieldKey: "priceVnd",
      chatType: "private",
      correlationId: "telegram:variant-field",
    });

    // A boolean field is answered with a button, and the same no-id rule keeps this route short.
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "variant-toggle",
      action: "ADMIN",
      callbackData: "admin:products:vfset:preorderEnabled:on",
    });
    expect(adminVariantEditToggle).toHaveBeenCalledWith({
      telegramUserId: USER,
      fieldKey: "preorderEnabled",
      on: true,
      chatType: "private",
      correlationId: "telegram:variant-toggle",
    });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("routes variant state text before the generic product wizard", async () => {
    const { dispatcher, workflowVariantText, workflowMessageText, send } = setup();
    workflowVariantText.mockResolvedValueOnce({ text: "variant saved", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "variant-text",
      action: "UNKNOWN",
      messageText: "state-1|SKU2|Premium 2|99000|CUSTOM|0|1",
    });

    expect(workflowVariantText).toHaveBeenCalledWith({
      telegramUserId: USER,
      text: "state-1|SKU2|Premium 2|99000|CUSTOM|0|1",
      chatType: "private",
      correlationId: "telegram:variant-text",
    });
    expect(workflowMessageText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes owner remediation prompt text before generic admin text", async () => {
    const { dispatcher, ownerPromptText, workflowMessageText, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "owner-remediation-text",
      action: "ADMIN",
      messageText: "OWNER_ATTESTATION|REF-1|pre-production authorization",
      ownerPromptText: true,
    });

    expect(ownerPromptText).toHaveBeenCalledWith({
      telegramUserId: USER,
      text: "OWNER_ATTESTATION|REF-1|pre-production authorization",
      chatType: "private",
      correlationId: "telegram:owner-remediation-text",
    });
    expect(workflowMessageText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes quantity stock adjustment callbacks and reason text", async () => {
    const { dispatcher, quantityAdjustPreview, quantityAdjustConfirm, quantityAdjustText, send } =
      setup();
    quantityAdjustText.mockResolvedValueOnce({ text: "qty reason preview", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "qty-add",
      action: "ADMIN",
      callbackData: "admin:inventory:qty:variant-1:1:64",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "qty-confirm",
      action: "ADMIN",
      callbackData: "admin:inventory:qty-confirm:state-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "qty-reason",
      action: "UNKNOWN",
      messageText: "cycle count correction",
    });

    expect(quantityAdjustPreview).toHaveBeenCalledWith({
      telegramUserId: USER,
      variantId: "variant-1",
      delta: 1,
      expectedStockVersion: 64,
      chatType: "private",
      correlationId: "telegram:qty-add",
    });
    expect(quantityAdjustConfirm).toHaveBeenCalledWith({
      telegramUserId: USER,
      stateId: "state-1",
      chatType: "private",
      correlationId: "telegram:qty-confirm",
    });
    expect(quantityAdjustText).toHaveBeenCalledWith({
      telegramUserId: USER,
      text: "cycle count correction",
      chatType: "private",
      correlationId: "telegram:qty-reason",
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("routes stock announcement preview from variant inventory", async () => {
    const { dispatcher, stockAnnouncementPreview, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "stock-announce",
      action: "ADMIN",
      callbackData: "admin:inventory:announce:variant-1",
    });

    expect(stockAnnouncementPreview).toHaveBeenCalledWith({
      telegramUserId: USER,
      variantId: "variant-1",
      chatType: "private",
      correlationId: "telegram:stock-announce",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes inventory history shortcut to the audit handler", async () => {
    const { dispatcher, adminAudit, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "inventory-audit",
      action: "ADMIN",
      callbackData: "admin:audit",
    });

    expect(adminAudit).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:inventory-audit",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes selected inventory template callbacks", async () => {
    const { dispatcher, importTemplate, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "inventory-template",
      action: "ADMIN",
      callbackData: "admin:inventory:template:variant-1",
    });

    expect(importTemplate).toHaveBeenCalledWith({
      telegramUserId: USER,
      variantId: "variant-1",
      chatType: "private",
      correlationId: "telegram:inventory-template",
    });
    expect(send).toHaveBeenCalledTimes(1);
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

  it("opens the owner's warranty queue from the menu entry and honours an explicit view", async () => {
    const { dispatcher, warrantyQueue, warrantyRefundQueue, warrantyClaim } = setup();

    // The menu button sends the bare prefix: it must open the default queue, not an error.
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "warranty-1",
      action: "ADMIN",
      callbackData: "admin:warranty",
    });
    expect(warrantyQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "new", telegramUserId: USER, chatType: "private" }),
    );

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "warranty-2",
      action: "ADMIN",
      callbackData: "admin:warranty:view:refund_due",
    });
    expect(warrantyQueue).toHaveBeenLastCalledWith(expect.objectContaining({ view: "refund_due" }));

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "warranty-3",
      action: "ADMIN",
      callbackData: "admin:warranty:refunds",
    });
    expect(warrantyRefundQueue).toHaveBeenCalledTimes(1);

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "warranty-4",
      action: "ADMIN",
      callbackData: "admin:warranty:claim:CLAIM-1",
    });
    expect(warrantyClaim).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: "CLAIM-1" }));
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

  it("routes active product workflow text before stale admin customer search", async () => {
    const { dispatcher, workflowMessageText, adminCustomerText, send } = setup();
    workflowMessageText.mockResolvedValueOnce({ text: "draft advanced", buttons: [] });
    adminCustomerText.mockResolvedValueOnce({ text: "customer search", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "draft-before-customer-search",
      action: "UNKNOWN",
      messageText: "CANARY P0 Inventory - KHONG BAN",
      rootProductDraftText: true,
    });

    expect(workflowMessageText).toHaveBeenCalledWith({
      telegramUserId: USER,
      text: "CANARY P0 Inventory - KHONG BAN",
      chatType: "private",
      correlationId: "telegram:draft-before-customer-search",
    });
    expect(adminCustomerText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("prioritizes /admin command even when rootProductDraftText is true", async () => {
    const { dispatcher, adminMainMenu, workflowMessageText, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "admin-cmd-priority",
      action: "ADMIN",
      command: "/admin",
      messageText: "/admin",
      rootProductDraftText: true,
    });

    expect(adminMainMenu).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:admin-cmd-priority",
    });
    expect(workflowMessageText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes products:back to workflow.back", async () => {
    const base = setup();
    const back = vi.fn().mockResolvedValue({ text: "back step", buttons: [] });
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
      responder: { send: base.send },
      admin: {
        handleToken: vi.fn(),
        workflow: {
          start: vi.fn(),
          messageText: base.workflowMessageText,
          cancel: vi.fn(),
          back,
        },
      },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "back-cb-1",
      action: "ADMIN",
      callbackData: "admin:products:back",
    });

    expect(back).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:back-cb-1",
    });
  });

  it("routes products:apply-sku:<sku> to workflow.applySku", async () => {
    const base = setup();
    const applySku = vi.fn().mockResolvedValue({ text: "sku applied", buttons: [] });
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
      responder: { send: base.send },
      admin: {
        handleToken: vi.fn(),
        workflow: {
          start: vi.fn(),
          messageText: base.workflowMessageText,
          cancel: vi.fn(),
          applySku,
        },
      },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "apply-sku-cb-1",
      action: "ADMIN",
      callbackData: "admin:products:apply-sku:GPT-PLUS-001",
    });

    expect(applySku).toHaveBeenCalledWith({
      telegramUserId: USER,
      sku: "GPT-PLUS-001",
      chatType: "private",
      correlationId: "telegram:apply-sku-cb-1",
    });
  });
  it("routes pay:refresh:<orderNumber> directly to checkout.refresh without codec error", async () => {
    const base = setup();
    const refresh = vi.fn().mockResolvedValue({ text: "order status", buttons: [] });
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
        refresh,
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: { list: vi.fn(), detail: vi.fn() },
      support: { reasonMenu: vi.fn(), open: vi.fn(), list: vi.fn() },
      responder: { send: base.send },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "pay-refresh-1",
      action: "UNKNOWN",
      callbackData: "pay:refresh:ORD-20260908-16QVJNC6",
    });

    expect(refresh).toHaveBeenCalledWith("ORD-20260908-16QVJNC6", CUSTOMER, {
      telegramUserId: USER,
      isRootAdmin: false,
    });
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
      resolveOrderByIdForOwner: vi.fn(),
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

  it("routes inventoryImportText marker envelope directly to importText", async () => {
    const base = setup();
    const importText = vi.fn().mockResolvedValue({
      text: "import preview from marker",
      buttons: [[{ text: "confirm", callbackData: "admin:inventory:confirm" }]],
    });
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
        handleToken: vi.fn(),
        mainMenu: base.adminMainMenu,
        dashboard: base.adminDashboard,
        products: base.adminProducts,
        productDetail: base.adminProductDetail,
        inventory: base.adminInventory,
        importText,
      },
      responder: { send: base.send },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "marker-import-1",
      action: "ADMIN",
      inventoryImportText: true,
      messageText: "user1|pass1\nuser2|pass2",
    });

    expect(importText).toHaveBeenCalledTimes(1);
    expect(importText).toHaveBeenCalledWith({
      telegramUserId: USER,
      text: "user1|pass1\nuser2|pass2",
      chatType: "private",
      correlationId: "telegram:marker-import-1",
    });
    expect(base.send).toHaveBeenCalledTimes(1);
    expect(base.send.mock.calls[0]![0].message.text).toBe("import preview from marker");
  });

  it("treats every group update as inert: no commerce handler and no reply", async () => {
    const base = setup();
    const historyList = vi.fn();
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
      history: { list: historyList, detail: vi.fn() },
      support: { reasonMenu: vi.fn(), open: vi.fn(), list: vi.fn() },
      admin: { handleToken: vi.fn() },
      responder: { send: base.send },
    });

    // Commerce commands, a mention-shaped question, a plain message and a new-member event.
    for (const update of [
      { command: "/shop" },
      { command: "/orders" },
      { command: "/hot" },
      { command: "/stock" },
      { command: "/support" },
      { messageText: "@tier20ai_bot shop có gì?" },
      { messageText: "hàng về chưa shop" },
      { newChatMembers: [{ id: 42, firstName: "New", isBot: false }] },
    ]) {
      await dispatcher.handle({
        actorUserId: USER,
        chatId: "-1003906082671",
        chatType: "supergroup",
        messageId: "grp-msg-1",
        messageThreadId: 42,
        action: "CATALOG",
        ...update,
      });
    }

    expect(base.send).not.toHaveBeenCalled();
    expect(historyList).not.toHaveBeenCalled();
    expect(base.mainMenu).not.toHaveBeenCalled();
  });

  it("never answers an inline query, so no commerce card can be posted into a chat", async () => {
    const base = setup();
    const answerInlineQuery = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTelegramDomainDispatcher({
      codec: base.codec,
      resolveCustomerId: vi.fn().mockResolvedValue(CUSTOMER),
      resolveOrderByIdForOwner: vi.fn(),
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
      admin: { handleToken: vi.fn() },
      responder: { send: base.send, answerInlineQuery },
    });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: null,
      action: "CATALOG",
      inlineQuery: { id: "iq-test-1", query: "claude", offset: "0" },
    });

    expect(answerInlineQuery).not.toHaveBeenCalled();
    expect(base.send).not.toHaveBeenCalled();
  });

  it("routes Telegram document envelopes to file import before storefront fallback", async () => {
    const { dispatcher, importDocument, mainMenu, send } = setup();
    const document = {
      fileId: "AgACAgUAAxkBAAIBfileid123",
      fileUniqueId: "unique_file_id",
      filename: "guide.pdf",
      mimeType: "application/pdf",
      fileSize: 12,
    };

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "file-doc-1",
      action: "UNKNOWN",
      document,
    });

    expect(importDocument).toHaveBeenCalledWith({
      telegramUserId: USER,
      document,
      chatType: "private",
      correlationId: "telegram:file-doc-1",
    });
    expect(mainMenu).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          text: "file preview",
          buttons: [[{ text: "activate", callbackData: "admin:inventory:file-confirm:state-1" }]],
        },
      }),
    );
  });

  it("routes file activation callbacks through bound state ids", async () => {
    const { dispatcher, importFileConfirm, send } = setup();
    const callbackData = "admin:inventory:file-confirm:state-1";

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "file-confirm-1",
      action: "ADMIN",
      callbackData,
    });

    expect(callbackData.length).toBeLessThanOrEqual(64);
    expect(importFileConfirm).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      stateId: "state-1",
      correlationId: "telegram:file-confirm-1",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: "file activated", buttons: [] } }),
    );
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
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: "confirmed", buttons: [] } }),
    );
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

  it("routes admin customer list/search/state/message callbacks without leaking customer ids in buttons", async () => {
    const {
      dispatcher,
      adminCustomers,
      adminCustomerState,
      adminCustomerSearch,
      adminCustomerMessagePrompt,
      send,
    } = setup();
    const stateId = newId();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cust-list",
      action: "ADMIN",
      callbackData: "admin:customers",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cust-filter",
      action: "ADMIN",
      callbackData: "admin:customers:filter:payment_review",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cust-search",
      action: "ADMIN",
      callbackData: "admin:customers:search",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cust-view",
      action: "ADMIN",
      callbackData: `admin:customers:view:${stateId}`,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cust-msg",
      action: "ADMIN",
      callbackData: `admin:customers:message:${stateId}`,
    });

    expect(adminCustomers).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: USER }));
    expect(adminCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ filter: "payment_review" }),
    );
    expect(adminCustomerSearch).toHaveBeenCalledTimes(1);
    expect(adminCustomerState).toHaveBeenCalledWith(expect.objectContaining({ stateId }));
    expect(adminCustomerMessagePrompt).toHaveBeenCalledWith(expect.objectContaining({ stateId }));
    expect(send).toHaveBeenCalledTimes(5);
    for (const call of send.mock.calls) {
      for (const button of call[0].message.buttons.flat())
        expect(button.callbackData).not.toContain(CUSTOMER);
    }
  });

  it("routes admin order list/filter/search/state/message callbacks through bounded state ids", async () => {
    const {
      dispatcher,
      adminOrders,
      adminOrderState,
      adminOrderSearch,
      adminOrderMessagePrompt,
      adminOrderText,
      adminCustomerText,
      send,
    } = setup();
    const stateId = newId();
    adminOrderText.mockResolvedValue({ text: "order text", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-list",
      action: "ADMIN",
      callbackData: "admin:orders",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-filter",
      action: "ADMIN",
      callbackData: "admin:orders:filter:payment_review",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-search",
      action: "ADMIN",
      callbackData: "admin:orders:search",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-view",
      action: "ADMIN",
      callbackData: `admin:orders:view:${stateId}`,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-page",
      action: "ADMIN",
      callbackData: `admin:orders:page:${stateId}`,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-msg",
      action: "ADMIN",
      callbackData: `admin:orders:message:${stateId}`,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "order-text",
      action: "UNKNOWN",
      messageText: "Xin chào theo đơn",
    });

    expect(adminOrders).toHaveBeenCalledWith(expect.objectContaining({ telegramUserId: USER }));
    expect(adminOrders).toHaveBeenCalledWith(expect.objectContaining({ filter: "payment_review" }));
    expect(adminOrderSearch).toHaveBeenCalledTimes(1);
    expect(adminOrderState).toHaveBeenCalledWith(expect.objectContaining({ stateId }));
    expect(adminOrderState).toHaveBeenCalledTimes(2);
    expect(adminOrderMessagePrompt).toHaveBeenCalledWith(expect.objectContaining({ stateId }));
    expect(adminOrderText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Xin chào theo đơn" }),
    );
    expect(adminCustomerText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "Xin chào theo đơn" }),
    );
    expect(send).toHaveBeenCalledTimes(7);
  });

  it("blocks wallet commands while leaving support routed to support", async () => {
    const { dispatcher, walletTopup, walletPay, supportReasonMenu, send } = setup();

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

    expect(walletTopup).not.toHaveBeenCalled();
    expect(walletPay).not.toHaveBeenCalled();
    expect(supportReasonMenu).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("routes the marketing broadcast compose, root-safe preview, confirm, status, and cancel flow", async () => {
    const {
      dispatcher,
      send,
      broadcastCompose,
      broadcastAudience,
      broadcastText,
      broadcastConfirm,
      broadcastStatus,
      broadcastCancel,
    } = setup();
    broadcastText.mockResolvedValue({ text: "preview", buttons: [] });

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m1",
      action: "ADMIN",
      callbackData: "admin:marketing:compose",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m2",
      action: "ADMIN",
      callbackData: "admin:marketing:audience:root",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m3",
      action: "UNKNOWN",
      messageText: "Hello root",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m4",
      action: "ADMIN",
      callbackData: "admin:marketing:confirm:campaign-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m5",
      action: "ADMIN",
      callbackData: "admin:marketing:status:campaign-1",
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "m6",
      action: "ADMIN",
      callbackData: "admin:marketing:cancel:campaign-1",
    });

    expect(broadcastCompose).toHaveBeenCalledTimes(1);
    expect(broadcastAudience).toHaveBeenCalledWith(expect.objectContaining({ audience: "root" }));
    expect(broadcastText).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello root" }));
    expect(broadcastConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-1" }),
    );
    expect(broadcastStatus).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-1" }),
    );
    expect(broadcastCancel).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-1" }),
    );
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

  it("opens a category from a sealed CATEGORY_VIEW token without treating it as a variant cursor", async () => {
    const { codec, dispatcher, categoryList, categoryView, send } = setup();
    const categoryId = newId();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "cat-view-sealed",
      action: "CATALOG",
      callbackData: codec.issue({
        action: "CATEGORY_VIEW",
        resourceId: categoryId,
        telegramUserId: USER,
      }),
    });
    expect(categoryView).toHaveBeenCalledWith(categoryId, undefined, {
      telegramUserId: USER,
      isRootAdmin: false,
    });
    expect(categoryList).not.toHaveBeenCalled();
    const categorySent = send.mock.calls[0]![0];
    expect(categorySent.message.text).toBe("category page");
    expect(categorySent.message.text).not.toMatch(/không tồn tại|không được hỗ trợ/i);
  });

  it("routes back and main-menu callbacks to catalog or shop home instead of error copy", async () => {
    const { codec, dispatcher, categoryList, send } = setup();
    const payloads = [
      "cat:list",
      "menu:main",
      codec.issue({ action: "CATEGORY_LIST", telegramUserId: USER }),
      codec.issue({ action: "MAIN_MENU", telegramUserId: USER }),
      codec.issue({ action: "SHOP_HOME", telegramUserId: USER }),
    ];
    for (const [index, callbackData] of payloads.entries()) {
      await dispatcher.handle({
        actorUserId: USER,
        chatId: USER,
        chatType: "private",
        messageId: `nav-back-${index}`,
        action: "CATALOG",
        callbackData,
      });
    }
    expect(categoryList).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(payloads.length);
    for (const call of send.mock.calls) {
      expect(call[0].message.text).not.toMatch(/không tồn tại|không được hỗ trợ|không hợp lệ/i);
      expect(call[0].message.text.trim()).not.toBe("");
    }
  });

  it("falls back to the category list when a catalog page cursor cannot be resolved", async () => {
    const { codec, dispatcher, categoryList, categoryView, send } = setup();
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "catalog-page-miss",
      action: "CATALOG",
      callbackData: codec.issue({
        action: "CATALOG_PAGE",
        resourceId: newId(),
        telegramUserId: USER,
      }),
    });
    expect(categoryView).not.toHaveBeenCalled();
    expect(categoryList).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].message.text).toBe("categories");
  });

  it("routes products:vis:<action> to workflow.visibilityAction", async () => {
    const { dispatcher, visibilityAction, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "vis-cb-1",
      action: "ADMIN",
      callbackData: "admin:products:vis:test",
    });

    expect(visibilityAction).toHaveBeenCalledWith({
      telegramUserId: USER,
      chatType: "private",
      correlationId: "telegram:vis-cb-1",
      action: "test",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: "visibility step", buttons: [] } }),
    );
  });

  it("routes persistent keyboard '🛒 Mua hàng' directly to storefront", async () => {
    const { dispatcher, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "browse-msg-1",
      action: "UNKNOWN",
      messageText: "🛒 Mua hàng",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].message.text).toContain("TIER20 SHOP");
  });

  it("routes persistent keyboard '🛡 Bảo hành' to customer warranty", async () => {
    const { dispatcher, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "warranty-msg-1",
      action: "UNKNOWN",
      messageText: "🛡 Bảo hành",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].message.text).toContain("Chính sách bảo hành & hỗ trợ");
  });

  it("routes preorder:consent:<variantId> to preorder.consent", async () => {
    const { dispatcher, preorderConsent, send } = setup();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "preorder-cb-1",
      action: "UNKNOWN",
      callbackData: "preorder:consent:var-123",
    });

    expect(preorderConsent).toHaveBeenCalledWith("var-123");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: "preorder consent", buttons: [] } }),
    );
  });

  it("routes the deposit QR route and the customer's own deposit list", async () => {
    const { dispatcher, preorderPay, preorderList, send } = setup();
    const reservationId = newId();

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "preorder-pay-raw",
      action: "UNKNOWN",
      callbackData: `preorder:pay:${reservationId}`,
    });

    // The handler re-derives the payable leg and re-authorises against the actor's
    // own customer id — the raw route never carries an amount.
    expect(preorderPay).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      reservationId,
      correlationId: "telegram:preorder-pay-raw",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ message: { text: "preorder deposit qr", buttons: [] } }),
    );

    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "preorder-list-raw",
      action: "UNKNOWN",
      callbackData: "cust:preorders",
    });

    expect(preorderList).toHaveBeenCalledWith(CUSTOMER);
  });

  it("routes the sealed deposit callbacks (preorder:pay / cust:preorders) after sealing", async () => {
    const { codec, dispatcher, preorderPay, preorderList } = setup();
    const reservationId = newId();

    const payToken = codec.issue({
      action: "PREORDER_PAY",
      resourceId: reservationId,
      telegramUserId: USER,
    });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "preorder-pay-sealed",
      action: "UNKNOWN",
      callbackData: payToken,
    });
    expect(preorderPay).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      reservationId,
      correlationId: "telegram:preorder-pay-sealed",
    });

    const listToken = codec.issue({ action: "PREORDER_LIST", telegramUserId: USER });
    await dispatcher.handle({
      actorUserId: USER,
      chatId: USER,
      chatType: "private",
      messageId: "preorder-list-sealed",
      action: "UNKNOWN",
      callbackData: listToken,
    });
    expect(preorderList).toHaveBeenCalledWith(CUSTOMER);
  });
});
