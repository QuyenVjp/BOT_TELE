import { describe, expect, it, vi } from "vitest";
import { createGrammyResponder } from "../../src/bot/grammy-responder.js";
import { presentAdminMenu } from "../../src/bot/presenters/admin.js";
import { presentCustomerAccountPrompt, presentCustomerHome } from "../../src/bot/presenters/customer.js";

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
      expect.arrayContaining(["🛍 Sản phẩm", "📦 Kho hàng", "🧾 Đơn hàng"]),
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
      reply_markup?: { keyboard?: Array<Array<{ text: string }>>; is_persistent?: boolean; resize_keyboard?: boolean };
    };
    expect(options.reply_markup?.is_persistent).toBe(true);
    expect(options.reply_markup?.resize_keyboard).toBe(true);
    expect(options.reply_markup?.keyboard?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["🛒 Mua hàng", "👤 Tài khoản", "🧾 Đơn hàng", "🛟 Hỗ trợ", "🌐 Mở cửa hàng"]),
    );
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
    expect(buttons.find((button) => button.text === "📱 Chia sẻ số điện thoại")?.request_contact).toBe(true);
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
