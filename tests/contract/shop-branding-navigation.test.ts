import { describe, expect, it, vi } from "vitest";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import { presentStorefront } from "../../src/bot/presenters/customer.js";
import { presentSupportReasonMenu } from "../../src/bot/presenters/support.js";
import { presentCategoryPage, presentMainMenu } from "../../src/bot/presenters/catalog.js";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_URL,
  SHOP_NAME,
} from "../../src/modules/catalog/shop-profile.js";
import { newId } from "../../src/shared/ids/index.js";

describe("customer branding presenters", () => {
  it("renders TIER20 SHOP home with URL-only community and admin buttons", () => {
    const home = presentStorefront({
      actorName: "Quyen",
      isRootAdmin: false,
      categories: [{ id: newId(), name: "🤖 AI" }],
    });
    expect(home.text).toContain(`👋 Chào Quyen!`);
    expect(home.text).toContain(`🛒 ${SHOP_NAME}`);
    expect(home.text).not.toContain("SHOP DIGITAL");
    const buttons = home.buttons.flat();
    expect(buttons.find((b) => b.text.includes("AI Codex Việt Nam"))?.url).toBe(COMMUNITY_URL);
    expect(buttons.find((b) => b.text.includes("Liên hệ Admin"))?.url).toBe(ADMIN_CONTACT_URL);
    expect(buttons.find((b) => b.text.includes("Quản trị"))).toBeUndefined();
    expect(buttons.every((b) => b.url || b.callbackData)).toBe(true);
  });

  it("keeps owner admin control separate from public admin contact", () => {
    const home = presentStorefront({ actorName: "Owner", isRootAdmin: true });
    const buttons = home.buttons.flat();
    expect(buttons.find((b) => b.text === "🛠 Quản trị")?.callbackData).toBe("admin:menu");
    expect(buttons.find((b) => b.text.includes("Liên hệ Admin"))?.url).toBe(ADMIN_CONTACT_URL);
  });

  it("renders the support screen with admin and community URL buttons", () => {
    const support = presentSupportReasonMenu();
    expect(support.text).toContain(`💬 HỖ TRỢ ${SHOP_NAME}`);
    expect(support.text).toContain("chủ đề");
    expect(support.buttons.flat().find((b) => b.text.includes("Nhắn Admin"))?.url).toBe(
      ADMIN_CONTACT_URL,
    );
    expect(support.buttons.flat().find((b) => b.text.includes("Cộng đồng"))?.url).toBe(
      COMMUNITY_URL,
    );
  });

  it("does not put admin URLs on category navigation", () => {
    const page = presentCategoryPage({
      category: {
        id: newId(),
        name_vi: "🤖 AI",
        slug: "ai",
        sort_order: 1,
        parent_id: null,
        icon: "🤖",
        display_name_vi: "🤖 AI",
        is_active: true,
        is_featured: false,
        featured_rank: null,
        child_count: 1,
        public_product_count: 1,
      },
      parent: null,
      children: [
        {
          id: newId(),
          name_vi: "Claude",
          slug: "claude",
          sort_order: 1,
          parent_id: "parent",
          icon: null,
          display_name_vi: "Claude",
          is_active: true,
          is_featured: false,
          featured_rank: null,
          child_count: 0,
          public_product_count: 1,
        },
      ],
      products: [],
      featured: [],
      page: 0,
      totalPages: 1,
      pageSize: 8,
    });
    expect(page.text).toContain(SHOP_NAME);
    expect(page.buttons.flat().some((b) => b.url === ADMIN_CONTACT_URL)).toBe(false);
    expect(presentMainMenu().text).toContain(SHOP_NAME);
    expect(
      presentMainMenu()
        .buttons.flat()
        .map((button) => button.text),
    ).not.toContain("🛍 Danh sách sản phẩm");
  });
});

describe("catalog callback ACK", () => {
  it("answers the callback before catalog render for sealed tokens", async () => {
    const codec = createCallbackTokenCodec({
      key: "test-only-telegram-dispatch-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const order = { ack: 0, send: 0, events: [] as string[] };
    const ack = vi.fn(async () => {
      order.events.push("ack");
    });
    const send = vi.fn(async (_input: { callbackQueryId?: string }) => {
      order.events.push("send");
      return { chatId: "123456789", messageId: "42" };
    });
    const storefront = vi.fn(async () => ({
      text: `🛒 ${SHOP_NAME}`,
      buttons: [],
    }));
    const dispatcher = createTelegramDomainDispatcher({
      codec,
      resolveCustomerId: vi.fn().mockResolvedValue("cust"),
      resolveOrderById: vi.fn().mockResolvedValue(null),
      resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
      resolveCatalogPage: vi.fn().mockResolvedValue(null),
      catalog: {
        mainMenu: vi.fn(async () => presentMainMenu()),
        categoryList: vi.fn(async () => ({ text: "cats", buttons: [] })),
        categoryView: vi.fn(async () => ({ text: "cat", buttons: [] })),
        variantDetail: vi.fn(),
        search: vi.fn(),
        storefront,
      },
      checkout: {
        buyNowFromCallback: vi.fn(),
        refresh: vi.fn(),
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: { list: vi.fn(), detail: vi.fn() },
      support: {
        reasonMenu: vi.fn(() => presentSupportReasonMenu()),
        open: vi.fn(),
        list: vi.fn(),
      },
      responder: { ack, send },
    });
    const token = codec.issue({ action: "SHOP_HOME", telegramUserId: "123456789" });
    await dispatcher.handle({
      actorUserId: "123456789",
      chatId: "123456789",
      chatType: "private",
      messageId: "42",
      action: "CATALOG",
      callbackData: token,
      callbackQueryId: "cq-1",
    });
    expect(ack).toHaveBeenCalledWith("cq-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(order.events[0]).toBe("ack");
    expect(order.events[1]).toBe("send");
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("callbackQueryId");
    expect(storefront).toHaveBeenCalled();
  });
});

describe("bot-only catalog navigation", () => {
  function dispatcherForNav() {
    const storefront = vi.fn(async () => ({
      text: `👋 Chào Quyen!\n🛒 ${SHOP_NAME}`,
      buttons: [[{ text: "🔎 Tìm sản phẩm", callbackData: "cat:search" }]],
    }));
    const search = vi.fn(async () => ({ text: "Kết quả tìm kiếm", buttons: [] }));
    const send = vi.fn();
    const codec = createCallbackTokenCodec({
      key: "test-only-telegram-dispatch-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const dispatcher = createTelegramDomainDispatcher({
      codec,
      resolveCustomerId: vi.fn().mockResolvedValue("cust"),
      resolveOrderById: vi.fn().mockResolvedValue(null),
      resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
      resolveCatalogPage: vi.fn().mockResolvedValue(null),
      catalog: {
        mainMenu: vi.fn(async () => presentMainMenu()),
        categoryList: vi.fn(async () => ({ text: "cats", buttons: [] })),
        categoryView: vi.fn(async () => ({ text: "cat", buttons: [] })),
        variantDetail: vi.fn(),
        search,
        storefront,
      },
      checkout: {
        buyNowFromCallback: vi.fn(),
        refresh: vi.fn(),
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: { list: vi.fn(), detail: vi.fn() },
      support: {
        reasonMenu: vi.fn(() => presentSupportReasonMenu()),
        open: vi.fn(),
        list: vi.fn(),
      },
      responder: { ack: vi.fn(), send },
    });
    return { storefront, codec, send, dispatcher };
  }

  it("opens catalog home from Mua hàng without Danh sách sản phẩm", async () => {
    const { dispatcher, storefront, send } = dispatcherForNav();
    await dispatcher.handle({
      actorUserId: "123456789",
      chatId: "123456789",
      chatType: "private",
      messageId: "7",
      action: "CATALOG",
      messageText: "🛒 Mua hàng",
      firstName: "Quyen",
    });
    expect(storefront).toHaveBeenCalled();
    const message = send.mock.calls[0]?.[0]?.message as {
      text: string;
      buttons: { text: string }[][];
    };
    expect(message.text).toContain(SHOP_NAME);
    expect(JSON.stringify(message.buttons)).not.toContain("Danh sách sản phẩm");
  });

  it("routes search prompt instead of the old product-list hop", async () => {
    const { dispatcher, codec, send } = dispatcherForNav();
    const token = codec.issue({ action: "SEARCH_PROMPT", telegramUserId: "123456789" });
    await dispatcher.handle({
      actorUserId: "123456789",
      chatId: "123456789",
      chatType: "private",
      messageId: "8",
      action: "CATALOG",
      callbackData: token,
      callbackQueryId: "cq-search",
    });
    const message = send.mock.calls[0]?.[0]?.message as { text: string };
    expect(message.text).toContain("TÌM SẢN PHẨM");
    expect(message.text).not.toContain("Danh sách sản phẩm");
  });

  it("recovers stale unsealed callbacks without calling them invalid", async () => {
    const { dispatcher, storefront, send } = dispatcherForNav();
    await dispatcher.handle({
      actorUserId: "123456789",
      chatId: "123456789",
      chatType: "private",
      messageId: "9",
      action: "CATALOG",
      callbackData: "not-a-valid-token",
      callbackQueryId: "cq-stale",
    });
    const message = send.mock.calls[0]?.[0]?.message as { text: string };
    expect(message.text).toContain("Phiên này đã cũ. Đã tải lại thông tin mới nhất.");
    expect(message.text).not.toContain("Yêu cầu không hợp lệ");
    expect(storefront).toHaveBeenCalled();
  });

  it("returns catalog home from Quay lại", async () => {
    const { dispatcher, storefront, send } = dispatcherForNav();
    await dispatcher.handle({
      actorUserId: "123456789",
      chatId: "123456789",
      chatType: "private",
      messageId: "10",
      action: "CATALOG",
      messageText: "↩️ Quay lại",
      firstName: "Quyen",
    });
    expect(storefront).toHaveBeenCalled();
    const message = send.mock.calls[0]?.[0]?.message as { text: string };
    expect(message.text).toContain(SHOP_NAME);
  });
});
