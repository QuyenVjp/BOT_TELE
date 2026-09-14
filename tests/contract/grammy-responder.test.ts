import { describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { createGrammyResponder, TelegramRetryableError } from "../../src/bot/grammy-responder.js";
import { presentAdminMenu } from "../../src/bot/presenters/admin.js";
import {
  presentCustomerAccountPrompt,
  presentCustomerHome,
  presentStorefront,
} from "../../src/bot/presenters/customer.js";
import {
  ADMIN_CONTACT_URL,
  COMMUNITY_BUTTON_LABEL,
  COMMUNITY_URL,
} from "../../src/modules/catalog/shop-profile.js";

const BOT_TOKEN = ["1234567890", "test-token-value-for-grammy-responder"].join(":");

describe("createGrammyResponder admin keyboards", () => {
  it.each([
    ["sendMessage", null],
    ["editMessageText", "42"],
  ] as const)("includes plain inline keyboard in %s payload", async (_method, messageId) => {
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
      expect(buttons.find((button) => button.text.includes(COMMUNITY_BUTTON_LABEL))?.url).toBe(
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
      deleteMessage: vi.fn(async () => true),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const message = presentStorefront({ actorName: "An", isRootAdmin: false });

    await responder.send({ chatId: "customer-chat", messageId: null, message });

    expect(sendCalls).toHaveLength(2);
    // The delivery message is what holds the reply keyboard open: deleting it retracts the
    // keyboard in the client, so the bottom buttons flash open and vanish. Regression guard.
    expect(api.deleteMessage).not.toHaveBeenCalled();
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
    // One short pointer line: not an empty placeholder, and not a restatement of the labels.
    const deliveryText = sendCalls[1]?.[1];
    expect(typeof deliveryText).toBe("string");
    expect(deliveryText as string).not.toBe(".");
    expect((deliveryText as string).length).toBeGreaterThan(0);
    expect((deliveryText as string).length).toBeLessThanOrEqual(60);
    for (const label of ["Mua hàng", "Đơn hàng", "Tài khoản", "Nạp ví", "Bảo hành", "Hỗ trợ"]) {
      expect(deliveryText as string).not.toContain(label);
    }

    // An edit repaints the screen the user is already on and must never re-send the keyboard.
    await responder.send({ chatId: "customer-chat", messageId: "42", message });
    expect(editCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(2);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("does not post a keyboard message for screens that merely carry both markups", async () => {
    const sendCalls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        sendCalls.push(args);
        return { message_id: 4 };
      }),
      editMessageText: vi.fn(),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const message = presentStorefront({ actorName: "An", isRootAdmin: false });

    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: { ...message, installPersistentKeyboard: false },
    });

    expect(sendCalls).toHaveLength(1);
  });

  it("returns the message identity Telegram assigned to a new send", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 909 }),
      editMessageText: vi.fn(),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    const sent = await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: presentStorefront({ actorName: "An", isRootAdmin: false }),
    });

    expect(sent).toEqual({ chatId: "customer-chat", messageId: "909" });
  });

  it("reports the edited message identity, including a no-op edit", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 910 }),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const message = presentStorefront({ actorName: "An", isRootAdmin: false });

    expect(await responder.send({ chatId: "c", messageId: "42", message })).toEqual({
      chatId: "c",
      messageId: "42",
    });

    api.editMessageText.mockRejectedValue(
      new GrammyError(
        "Call to 'editMessageText' failed!",
        { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
        "editMessageText",
        {},
      ),
    );
    expect(await responder.send({ chatId: "c", messageId: "42", message })).toEqual({
      chatId: "c",
      messageId: "42",
    });
  });

  it("returns the replacement identity when Telegram no longer holds the edited message", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 911 }),
      editMessageText: vi
        .fn()
        .mockRejectedValue(
          new GrammyError(
            "Call to 'editMessageText' failed!",
            { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
            "editMessageText",
            {},
          ),
        ),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    const sent = await responder.send({
      chatId: "c",
      messageId: "42",
      message: presentStorefront({ actorName: "An", isRootAdmin: false }),
    });

    expect(sent).toEqual({ chatId: "c", messageId: "911" });
    // The panel itself was re-posted as a new message rather than edited.
    expect(String(api.sendMessage.mock.calls[0]?.[1])).toContain("TIER20");
  });

  it("does not silently swallow a transient edit failure", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 912 }),
      editMessageText: vi.fn().mockRejectedValue(
        new GrammyError(
          "Call to 'editMessageText' failed!",
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 30",
            parameters: { retry_after: 30 },
          },
          "editMessageText",
          {},
        ),
      ),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);

    const failure = await responder
      .send({
        chatId: "c",
        messageId: "42",
        message: presentStorefront({ actorName: "An", isRootAdmin: false }),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramRetryableError);
    expect((failure as TelegramRetryableError).retryAfterSeconds).toBe(30);
    expect(api.sendMessage).not.toHaveBeenCalled();
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

  it("routes implicit grammY calls through Telegram test environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { id: 1, type: "private" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const responder = createGrammyResponder(BOT_TOKEN, undefined, undefined, {
      environment: "test",
      fetch: fetchImpl,
    });

    await responder.getChat!("1");

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/bot${BOT_TOKEN}/test/getChat`);
  });
});

describe("createGrammyResponder payment copy_text", () => {
  it("emits native copy_text markup for payment copy buttons", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      editMessageCaption: vi.fn(),
      sendPhoto: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return { message_id: 11 };
      }),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: {
        text: "pay",
        photo: Buffer.from("png"),
        buttons: [
          [{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }],
          [{ text: "✅ Kiểm tra thanh toán", callbackData: "pay:refresh:ORD-1" }],
        ],
      },
    });
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const options = calls[0]?.at(-1) as {
      caption?: string;
      reply_markup?: {
        inline_keyboard?: Array<
          Array<{ text: string; copy_text?: { text: string }; callback_data?: string }>
        >;
      };
    };
    expect(options.caption).toBe("pay");
    const buttons = options.reply_markup?.inline_keyboard?.flat() ?? [];
    const copy = buttons.find((button) => button.copy_text);
    expect(copy).toMatchObject({
      text: "📋 Sao chép STK",
      copy_text: { text: "0123456789" },
    });
    expect(copy).not.toHaveProperty("callback_data");
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "✅ Kiểm tra thanh toán",
          callback_data: "pay:refresh:ORD-1",
        }),
      ]),
    );
  });

  it("edits a photo caption when editMessageText is rejected", async () => {
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(async () => {
        throw new GrammyError(
          "Call to 'editMessageText' failed!",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: there is no text in the message to edit",
          },
          "editMessageText",
          {},
        );
      }),
      editMessageCaption: vi.fn(async () => true),
      sendPhoto: vi.fn(),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const result = await responder.send({
      chatId: "customer-chat",
      messageId: "88",
      message: {
        text: "fallback caption",
        buttons: [[{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }]],
      },
    });
    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ chatId: "customer-chat", messageId: "88" });
  });

  it("degrades to a text reply when Telegram permanently rejects the photo", async () => {
    const sent: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        sent.push(args);
        return { message_id: 77 };
      }),
      editMessageText: vi.fn(),
      editMessageCaption: vi.fn(),
      sendPhoto: vi.fn(async () => {
        throw new GrammyError(
          "Call to 'sendPhoto' failed!",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: PHOTO_INVALID_DIMENSIONS",
          },
          "sendPhoto",
          {},
        );
      }),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const result = await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: {
        text: "💳 Thanh toán đơn #ORD-1",
        photo: Buffer.from("png"),
        buttons: [[{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }]],
      },
    });

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(sent[0]?.[1]).toBe("💳 Thanh toán đơn #ORD-1");
    const options = sent[0]?.at(-1) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ copy_text?: { text: string } }>> };
    };
    expect(options.reply_markup?.inline_keyboard?.flat()?.[0]?.copy_text).toEqual({
      text: "0123456789",
    });
    expect(result).toEqual({ chatId: "customer-chat", messageId: "77" });
  });

  it("still surfaces a rate-limited photo failure instead of degrading to text", async () => {
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      editMessageCaption: vi.fn(),
      sendPhoto: vi.fn(async () => {
        throw new GrammyError(
          "Call to 'sendPhoto' failed!",
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 3",
            parameters: { retry_after: 3 },
          },
          "sendPhoto",
          {},
        );
      }),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    await expect(
      responder.send({
        chatId: "customer-chat",
        messageId: null,
        message: {
          text: "pay",
          photo: Buffer.from("png"),
          buttons: [[{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }]],
        },
      }),
    ).rejects.toBeInstanceOf(TelegramRetryableError);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("re-sends the card as a photo when the media edit is rejected", async () => {
    const sent: unknown[][] = [];
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      editMessageCaption: vi.fn(),
      sendPhoto: vi.fn(async (...args: unknown[]) => {
        sent.push(args);
        return { message_id: 99 };
      }),
      editMessageMedia: vi.fn(async () => {
        throw new GrammyError(
          "Call to 'editMessageMedia' failed!",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: there is no photo in the message to edit",
          },
          "editMessageMedia",
          {},
        );
      }),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const result = await responder.send({
      chatId: "customer-chat",
      messageId: "88",
      message: {
        text: "💳 Thanh toán đơn #ORD-1",
        photo: Buffer.from("png"),
        buttons: [
          [{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }],
          [{ text: "✅ Kiểm tra thanh toán", callbackData: "pay:refresh:ORD-1" }],
        ],
      },
    });
    expect(api.editMessageMedia).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(sent[0]?.[1]).toBeDefined();
    const options = sent[0]?.at(-1) as {
      caption?: string;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text?: string; copy_text?: { text: string } }>>;
      };
    };
    expect(options.caption).toBe("💳 Thanh toán đơn #ORD-1");
    const flat = options.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(flat[0]?.copy_text).toEqual({ text: "0123456789" });
    expect(flat.some((button) => button.text === "✅ Kiểm tra thanh toán")).toBe(true);
    expect(result).toEqual({ chatId: "customer-chat", messageId: "99" });
  });

  it("falls all the way back to text when both the media edit and the photo send fail", async () => {
    const edits: unknown[][] = [];
    const rejects = (method: string, description: string) =>
      vi.fn(async () => {
        throw new GrammyError(
          `Call to '${method}' failed!`,
          { ok: false, error_code: 400, description },
          method,
          {},
        );
      });
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(async (...args: unknown[]) => {
        edits.push(args);
        return { message_id: 88 };
      }),
      editMessageCaption: vi.fn(),
      editMessageMedia: rejects("editMessageMedia", "Bad Request: message to edit not found"),
      sendPhoto: rejects("sendPhoto", "Bad Request: PHOTO_INVALID_DIMENSIONS"),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const result = await responder.send({
      chatId: "customer-chat",
      messageId: "88",
      message: {
        text: "💳 Thanh toán đơn #ORD-1",
        photo: Buffer.from("png"),
        buttons: [[{ text: "✅ Kiểm tra thanh toán", callbackData: "pay:refresh:ORD-1" }]],
      },
    });
    // The existing bubble is rewritten in place — no second message is posted.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(edits[0]?.[2]).toBe("💳 Thanh toán đơn #ORD-1");
    const options = edits[0]?.at(-1) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    };
    expect(options.reply_markup?.inline_keyboard?.flat()?.[0]?.callback_data).toBe(
      "pay:refresh:ORD-1",
    );
    expect(result).toEqual({ chatId: "customer-chat", messageId: "88" });
  });

  it("sends the photo and no text reply when Telegram accepts it", async () => {
    const api = {
      sendMessage: vi.fn(),
      editMessageText: vi.fn(),
      editMessageCaption: vi.fn(),
      sendPhoto: vi.fn(async () => ({ message_id: 55 })),
      editMessageMedia: vi.fn(),
    };
    const responder = createGrammyResponder(BOT_TOKEN, api as never);
    const result = await responder.send({
      chatId: "customer-chat",
      messageId: null,
      message: {
        text: "pay",
        photo: Buffer.from("png"),
        buttons: [[{ text: "📋 Sao chép STK", callbackData: "", copyText: "0123456789" }]],
      },
    });
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ chatId: "customer-chat", messageId: "55" });
  });
});
