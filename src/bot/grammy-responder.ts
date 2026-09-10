import {
  Api,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
  InputMediaBuilder,
  Keyboard,
} from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from "grammy/types";
import type { PresentedMessage } from "./presenters/catalog.js";
import type { TelegramDocumentSender } from "../modules/digital-goods/file-delivery.js";

export interface InlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  input_message_content: {
    message_text: string;
    parse_mode?: "Markdown" | "HTML";
  };
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
  };
  description?: string;
  thumb_url?: string;
}

export interface TelegramResponder {
  ack?(callbackQueryId: string): Promise<void>;
  send(input: {
    chatId: string;
    messageId: string | null;
    callbackQueryId?: string;
    message: PresentedMessage;
    messageThreadId?: number | null;
  }): Promise<void>;
  answerInlineQuery?(
    inlineQueryId: string,
    results: InlineQueryResultArticle[],
    options?: {
      cacheTime?: number;
      isPersonal?: boolean;
      switchPmText?: string;
      switchPmParameter?: string;
    },
  ): Promise<void>;
  getChat?(chatId: string | number): Promise<unknown>;
  getChatMember?(chatId: string | number, userId: number): Promise<unknown>;
  pinChatMessage?(chatId: string | number, messageId: number): Promise<void>;
  deleteMessage?(chatId: string | number, messageId: number): Promise<void>;
}

export class TelegramRetryableError extends Error {
  override name = "TelegramRetryableError";
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export class TelegramAmbiguousSendError extends Error {
  override name = "TelegramAmbiguousSendError";
}

type TelegramApi = Pick<
  Api,
  | "answerCallbackQuery"
  | "answerInlineQuery"
  | "editMessageMedia"
  | "editMessageText"
  | "sendDocument"
  | "sendPhoto"
  | "sendMessage"
  | "getChat"
  | "getChatMember"
  | "pinChatMessage"
  | "deleteMessage"
>;

type TelegramResponderTrace = {
  info(data: Record<string, unknown>, message?: string): void;
};

function classifyTelegramError(
  error: unknown,
): "message-not-modified" | "non-editable-or-missing" | "rate-limited" | "transient" | "permanent" {
  if (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    /message is not modified/i.test(error.description)
  ) {
    return "message-not-modified";
  }
  if (error instanceof GrammyError && error.error_code === 400) return "non-editable-or-missing";
  if (error instanceof GrammyError && error.error_code === 429) return "rate-limited";
  if (error instanceof GrammyError && error.error_code >= 500) return "transient";
  if (error instanceof HttpError || !(error instanceof GrammyError)) return "transient";
  return "permanent";
}

function retryAfterSeconds(error: unknown): number | null {
  return error instanceof GrammyError && typeof error.parameters.retry_after === "number"
    ? error.parameters.retry_after
    : null;
}

function isSendMethod(method: string): boolean {
  return method === "sendMessage" || method === "sendPhoto" || method === "sendDocument";
}

async function callTelegram<T>(method: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const retryAfter = retryAfterSeconds(error);
    if (classifyTelegramError(error) === "rate-limited") {
      throw new TelegramRetryableError(`Telegram ${method} rate-limited`, retryAfter);
    }
    if (isSendMethod(method) && (error instanceof HttpError || !(error instanceof GrammyError))) {
      throw new TelegramAmbiguousSendError();
    }
    if (classifyTelegramError(error) === "transient") {
      throw new TelegramRetryableError(`Telegram ${method} is retryable`, retryAfter);
    }
    throw error;
  }
}

function summarizeMessage(message: PresentedMessage): Record<string, unknown> {
  return {
    text_length: message.text.length,
    buttons: message.buttons.length,
    has_photo: Boolean(message.photo),
    has_document: Boolean(message.document),
    has_reply_keyboard: Boolean(message.replyKeyboard),
  };
}

function summarizeTelegramResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { ok: false };
  const row = result as Record<string, unknown>;
  const message = row.message as Record<string, unknown> | undefined;
  const document = message?.document as Record<string, unknown> | undefined;
  return {
    ok: true,
    message_id: row.message_id ?? message?.message_id ?? null,
    document_file_id: document?.file_id ?? null,
    document_file_unique_id: document?.file_unique_id ?? null,
  };
}

function traceTelegram(
  trace: TelegramResponderTrace | undefined,
  payload: Record<string, unknown>,
): void {
  trace?.info(payload, "telegram outbound payload");
}

function resolveDocument(document: PresentedMessage["document"]): string | InputFile {
  if (typeof document === "string") return document;
  if (!document) throw new Error("Presented document is missing");
  if (document.kind === "file_path") return new InputFile(document.value, document.filename);
  if (document.kind === "buffer") return new InputFile(document.value, document.filename);
  return document.value;
}

function buildReplyKeyboard(
  replyKeyboard: NonNullable<PresentedMessage["replyKeyboard"]>,
): Keyboard {
  const keyboard = Keyboard.from(
    replyKeyboard.buttons.map((row) =>
      row.map((button) =>
        button.requestContact ? Keyboard.requestContact(button.text) : Keyboard.text(button.text),
      ),
    ),
  );
  keyboard.resized(replyKeyboard.resizeKeyboard ?? true);
  keyboard.persistent(replyKeyboard.persistent ?? true);
  return keyboard;
}
type SendReplyMarkup =
  InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;
type EditReplyMarkup = InlineKeyboardMarkup;

function buildReplyMarkup(message: PresentedMessage): SendReplyMarkup {
  const inline = new InlineKeyboard();
  for (const row of message.buttons) {
    for (const button of row) {
      if (button.switchInlineQueryCurrentChat !== undefined) {
        inline.switchInlineCurrent(button.text, button.switchInlineQueryCurrentChat);
      } else if (button.url) {
        inline.url(button.text, button.url);
      } else {
        inline.text(button.text, button.callbackData ?? "");
      }
    }
    inline.row();
  }
  // Telegram allows only one reply_markup. Catalog /start and shop home carry both
  // inline URL buttons and a persistent reply keyboard — prefer the inline keyboard
  // or community/admin URL buttons never reach the customer.
  if (message.buttons.length > 0) return inline;
  if (message.replyKeyboard) return buildReplyKeyboard(message.replyKeyboard);
  return inline;
}

function buildEditReplyMarkup(replyMarkup: SendReplyMarkup): EditReplyMarkup {
  if ("inline_keyboard" in replyMarkup) return replyMarkup;
  return new InlineKeyboard();
}

function telegramFileIds(result: unknown): { fileId: string; fileUniqueId: string | null } {
  if (!result || typeof result !== "object" || !("document" in result))
    throw new Error("Telegram document response missing");
  const document = result.document;
  if (
    !document ||
    typeof document !== "object" ||
    !("file_id" in document) ||
    typeof document.file_id !== "string"
  ) {
    throw new Error("Telegram document file_id missing");
  }
  const unique = "file_unique_id" in document ? document.file_unique_id : null;
  return {
    fileId: document.file_id,
    fileUniqueId: typeof unique === "string" ? unique : null,
  };
}

export const TELEGRAM_CUSTOMER_BOT_COMMANDS = [
  { command: "start", description: "Mở TIER20 SHOP" },
  { command: "shop", description: "Xem sản phẩm" },
  { command: "orders", description: "Đơn hàng của tôi" },
  { command: "wallet", description: "Ví của tôi" },
  { command: "warranty", description: "Bảo hành" },
  { command: "support", description: "Hỗ trợ" },
  { command: "settings", description: "Cài đặt" },
  { command: "help", description: "Hướng dẫn" },
] as const;

export const TELEGRAM_OWNER_BOT_COMMANDS = [
  { command: "admin", description: "Quản trị" },
  { command: "products", description: "Sản phẩm" },
  { command: "inventory", description: "Kho hàng" },
  { command: "customers", description: "Khách hàng" },
  { command: "broadcast", description: "Thông báo" },
  { command: "health", description: "Hệ thống" },
] as const;

export const TELEGRAM_GROUP_BOT_COMMANDS = [
  { command: "shop", description: "Xem sản phẩm" },
  { command: "tim", description: "Tìm sản phẩm" },
  { command: "hot", description: "Sản phẩm nổi bật" },
  { command: "new", description: "Hàng mới" },
  { command: "stock", description: "Kiểm tra còn hàng" },
  { command: "support", description: "Hỗ trợ" },
] as const;

/** Command menu only — never MenuButtonWebApp. Failures are non-fatal at worker boot. */
export async function ensureTelegramCommandMenu(input: {
  botToken: string;
  adminTelegramUserId?: number;
}): Promise<void> {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const api = new Api(input.botToken);
  await api.setChatMenuButton({ menu_button: { type: "commands" } });
  await api.setMyCommands([...TELEGRAM_CUSTOMER_BOT_COMMANDS], {
    scope: { type: "all_private_chats" },
  });
  await api.setMyCommands([...TELEGRAM_GROUP_BOT_COMMANDS], {
    scope: { type: "all_group_chats" },
  });
  if (input.adminTelegramUserId !== undefined) {
    await api.setMyCommands([...TELEGRAM_CUSTOMER_BOT_COMMANDS, ...TELEGRAM_OWNER_BOT_COMMANDS], {
      scope: { type: "chat", chat_id: input.adminTelegramUserId },
    });
  }
}

export function createGrammyDocumentSender(
  botToken: string,
  api?: Pick<Api, "sendDocument">,
  trace?: TelegramResponderTrace,
): TelegramDocumentSender {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const telegramApi = api ?? new Api(botToken);
  return {
    async sendDocument(input) {
      const source =
        input.source.kind === "bytes"
          ? new InputFile(input.source.bytes, input.filename)
          : input.source.fileId;
      const result = await callTelegram("sendDocument", () =>
        telegramApi.sendDocument(input.chatId, source, {
          caption: input.caption,
        }),
      );
      const ids = telegramFileIds(result);
      traceTelegram(trace, {
        method: "sendDocument",
        document_file_id: ids.fileId,
        document_file_unique_id: ids.fileUniqueId,
      });
      return ids;
    },
  };
}

/** Real grammY API adapter for durable webhook-worker dispatch. */
export function createGrammyResponder(
  botToken: string,
  api?: TelegramApi,
  trace?: TelegramResponderTrace,
): TelegramResponder {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const telegramApi = api ?? new Api(botToken);
  const answered = new Set<string>();
  const ack = async (callbackQueryId: string) => {
    if (answered.has(callbackQueryId)) return;
    answered.add(callbackQueryId);
    if (answered.size > 4000) {
      const oldest = answered.values().next().value;
      if (oldest) answered.delete(oldest);
    }
    const t0 = Date.now();
    await telegramApi.answerCallbackQuery(callbackQueryId).catch(() => undefined);
    return { rttMs: Date.now() - t0 };
  };
  return {
    async ack(callbackQueryId) {
      await ack(callbackQueryId);
    },
    async answerInlineQuery(inlineQueryId, results, options) {
      await callTelegram("answerInlineQuery", () =>
        telegramApi.answerInlineQuery(
          inlineQueryId,
          results as unknown as Parameters<Api["answerInlineQuery"]>[1],
          {
            cache_time: options?.cacheTime ?? 10,
            is_personal: options?.isPersonal ?? false,
            ...(options?.switchPmText
              ? {
                  button: {
                    text: options.switchPmText,
                    start_parameter: options.switchPmParameter ?? "start",
                  },
                }
              : {}),
          },
        ),
      );
    },
    async getChat(chatId) {
      return callTelegram("getChat", () => telegramApi.getChat(chatId));
    },
    async getChatMember(chatId, userId) {
      return callTelegram("getChatMember", () => telegramApi.getChatMember(chatId, userId));
    },
    async pinChatMessage(chatId, messageId) {
      await callTelegram("pinChatMessage", () => telegramApi.pinChatMessage(chatId, messageId));
    },
    async deleteMessage(chatId, messageId) {
      await callTelegram("deleteMessage", () => telegramApi.deleteMessage(chatId, messageId));
    },
    async send(input) {
      if (input.callbackQueryId) {
        await ack(input.callbackQueryId);
      }
      const replyMarkup = buildReplyMarkup(input.message);
      const editReplyMarkup = buildEditReplyMarkup(replyMarkup);
      traceTelegram(trace, {
        method: input.message.document
          ? "sendDocument"
          : input.message.photo
            ? input.messageId
              ? "editMessageMedia"
              : "sendPhoto"
            : input.messageId
              ? "editMessageText"
              : "sendMessage",
        ...summarizeMessage(input.message),
        has_reply_markup: true,
        inline_keyboard_rows: input.message.buttons.length,
      });
      if (input.message.document) {
        const result = await callTelegram("sendDocument", () =>
          telegramApi.sendDocument(input.chatId, resolveDocument(input.message.document), {
            caption: input.message.text,
            reply_markup: replyMarkup,
          }),
        );
        traceTelegram(trace, { method: "sendDocument", ...summarizeTelegramResult(result) });
        return;
      }
      if (input.message.photo && input.messageId) {
        try {
          const result = await callTelegram("editMessageMedia", () =>
            telegramApi.editMessageMedia(
              input.chatId,
              Number(input.messageId),
              InputMediaBuilder.photo(new InputFile(input.message.photo!), {
                caption: input.message.text,
              }),
              { reply_markup: editReplyMarkup },
            ),
          );
          traceTelegram(trace, { method: "editMessageMedia", ...summarizeTelegramResult(result) });
          return;
        } catch (error) {
          if (classifyTelegramError(error) === "message-not-modified") return;
          if (classifyTelegramError(error) !== "non-editable-or-missing") throw error;
        }
      }
      if (input.message.photo) {
        const result = await callTelegram("sendPhoto", () =>
          telegramApi.sendPhoto(input.chatId, new InputFile(input.message.photo!), {
            caption: input.message.text,
            reply_markup: replyMarkup,
          }),
        );
        traceTelegram(trace, { method: "sendPhoto", ...summarizeTelegramResult(result) });
        return;
      }
      if (input.messageId) {
        try {
          const result = await callTelegram("editMessageText", () =>
            telegramApi.editMessageText(input.chatId, Number(input.messageId), input.message.text, {
              reply_markup: editReplyMarkup,
            }),
          );
          traceTelegram(trace, { method: "editMessageText", ...summarizeTelegramResult(result) });
          return;
        } catch (error) {
          if (classifyTelegramError(error) === "message-not-modified") return;
          if (classifyTelegramError(error) !== "non-editable-or-missing") throw error;
        }
      }
      const result = await callTelegram("sendMessage", () =>
        telegramApi.sendMessage(input.chatId, input.message.text, {
          reply_markup: replyMarkup,
          ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {}),
        }),
      );
      traceTelegram(trace, { method: "sendMessage", ...summarizeTelegramResult(result) });
    },
  };
}
