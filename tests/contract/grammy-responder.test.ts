import { describe, expect, it, vi } from "vitest";
import { createGrammyResponder } from "../../src/bot/grammy-responder.js";
import { presentAdminMenu } from "../../src/bot/presenters/admin.js";
import {
  presentCustomerAccountPrompt,
  presentCustomerHome,
  presentStorefront,
} from "../../src/bot/presenters/customer.js";
import { ADMIN_CONTACT_URL, COMMUNITY_URL } from "../../src/modules/catalog/shop-profile.js";

const BOT_TOKEN = ["1234567890", "test-token-value-for-grammy-responder"].join(":");

describe("createGrammyResponder admin keyboards", () => {
  it.each([
    ["sendMessage", null],
    ["editMessageText", "42"],
  ] as const)("includes plain inline keyboard in %s payload", async (method, messageId) => {
    const calls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { message_id: 1 };
      }),
      editMessageText: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return true;
      }),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    await responder.send({
      chatId: "admin-chat",
      messageId,
      message: presentAdminMenu(),
    });

    const options = calls[0]?.at(-1) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    const keyboard = options.reply_markup?.inline_keyboard;
    expect(keyboard).toBeDefined();
    const buttons = keyboard?.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(["📦 Sản phẩm", "📥 Kho hàng", "🧾 Đơn hàng"]),
    );
    expect(buttons.every((button) => button.callback_data.length <= 64)).toBe(true);
  });

  it("renders the persistent reply keyboard for the customer home screen", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { message_id: 2 };
      }),
      editMessageText: vi.fn(),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: presentCustomerHome(),
    });

    const options = calls[0]?.at(-1) as {
      reply_markup?: {
        keyboard?: Array<Array<{ text: string }>>;
        is_persistent?: boolean;
        resize_keyboard?: boolean;
      };
    };
    expect(options.reply_markup?.is_persistent).toBe(true);
    expect(options.reply_markup?.resize_keyboard).toBe(true);
    expect(options.reply_markup?.keyboard?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["🛒 Mua hàng", "👤 Tài khoản", "🧾 Đơn hàng", "💰 Nạp ví"]),
    );
  });

  it("keeps /start URL buttons when storefront also has a reply keyboard", async () => {
    const sendCalls: unknown[][] = [];
    const editCalls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        sendCalls.push(args);
        return { message_id: 4 };
      }),
      editMessageText: vi.fn(async (...args: unknown[]) => {
        editCalls.push(args);
        return true;
      }),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const message = presentStorefront({ actorName: "An", isRootAdmin: false });

    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message,
    });
    await responder.send({
      chatId: "customer-chat",
      messageId: "42",
      message,
    });

    const sendOptions = sendCalls[0]?.at(-1) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; url?: string }>> };
    };
    const editOptions = editCalls[0]?.at(-1) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; url?: string }>> };
    };
    for (const options of [sendOptions, editOptions]) {
      const buttons = options.reply_markup?.inline_keyboard?.flat() ?? [];
      expect(buttons.find((button) => button.text.includes("AI Codex Việt Nam"))?.url).toBe(
        COMMUNITY_URL,
      );
      expect(buttons.find((button) => button.text.includes("Liên hệ Admin"))?.url).toBe(
        ADMIN_CONTACT_URL,
      );
      expect(buttons.every((button) => !button.url || !("callback_data" in button))).toBe(true);
    }
  });

  it("delivers the persistent customer keyboard on a follow-up message for /start only", async () => {
    const sendCalls: unknown[][] = [];
    const editCalls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        sendCalls.push(args);
        return { message_id: 4 };
      }),
      editMessageText: vi.fn(async (...args: unknown[]) => {
        editCalls.push(args);
        return true;
      }),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const message = presentStorefront({ actorName: "An", isRootAdmin: false });

    await responder.send({ chatId: "customer-chat", messageId: null, message });

    expect(sendCalls).toHaveLength(2);
    const keyboardOptions = sendCalls[1]?.at(-1) as {
      reply_markup?: {
        keyboard?: Array<Array<{ text: string }>>;
        resize_keyboard?: boolean;
        one_time_keyboard?: boolean;
      };
    };
    expect(keyboardOptions.reply_markup?.keyboard?.flat().map((button) => button.text)).toEqual([
      "🛒 Mua hàng",
      "🧾 Đơn hàng",
      "👤 Tài khoản",
      "💰 Nạp ví",
      "🛡 Bảo hành",
      "💬 Hỗ trợ",
    ]);
    expect(keyboardOptions.reply_markup?.resize_keyboard).toBe(true);
    expect(keyboardOptions.reply_markup?.one_time_keyboard).not.toBe(true);

    // An edit repaints the screen the user is already on and must never re-send the keyboard.
    await responder.send({ chatId: "customer-chat", messageId: "42", message });
    expect(editCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(2);
  });

  it("renders contact-request reply keyboard for the account screen", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { message_id: 3 };
      }),
      editMessageText: vi.fn(),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: presentCustomerAccountPrompt(),
    });

    const options = calls[0]?.at(-1) as {
      reply_markup?: { keyboard?: Array<Array<{ text: string; request_contact?: boolean }>> };
    };
    const buttons = options.reply_markup?.keyboard?.flat() ?? [];
    expect(
      buttons.find((button) => button.text === "📱 Chia sẻ số điện thoại")?.request_contact,
    ).toBe(true);
  });

  it("sends documents when the presented message carries a document", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
      sendDocument: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { message_id: 7, document: { file_id: "file-id", file_unique_id: "uniq" } };
      }),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: {
        text: "Xin chào",
        buttons: [[{ text: "OK", callbackData: "ok" }]],
        document: "file_id_cached_release",
      },
    });

    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(calls[0]?.[1]).toBe("file_id_cached_release");
  });
});
