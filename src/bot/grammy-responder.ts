import {
  Api,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
  InputMediaBuilder,
  Keyboard,
} from "grammy";
import type { ApiClientOptions } from "grammy";
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

/** Identity of the Telegram message a `send` created or edited. */
export interface SentTelegramMessage {
  chatId: string;
  messageId: string;
}

export interface TelegramResponder {
  ack?(callbackQueryId: string): Promise<void>;
  /**
   * Create or edit a message. Resolves to the resulting Telegram message identity so callers
   * can persist it (a durable panel must remember the id it owns), or `null` when the message
   * was left untouched (nothing to change).
   */
  send(input: {
    chatId: string;
    messageId: string | null;
    callbackQueryId?: string;
    message: PresentedMessage;
    messageThreadId?: number | null;
  }): Promise<SentTelegramMessage | null>;
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
  | "editMessageCaption"
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

function inlineButtonFace(button: {
  text: string;
  style?: "primary" | "success" | "danger";
}): string | { text: string; style: "primary" | "success" | "danger" } {
  return button.style ? { text: button.text, style: button.style } : button.text;
}

function buildReplyMarkup(message: PresentedMessage): SendReplyMarkup {
  const inline = new InlineKeyboard();
  for (const row of message.buttons) {
    for (const button of row) {
      if (button.copyText) {
        inline.copyText(inlineButtonFace(button), button.copyText);
      } else if (button.switchInlineQueryCurrentChat !== undefined) {
        inline.switchInlineCurrent(button.text, button.switchInlineQueryCurrentChat);
      } else if (button.url) {
        inline.url(inlineButtonFace(button), button.url);
      } else {
        inline.text(inlineButtonFace(button), button.callbackData ?? "");
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

/**
 * Prompt that carries the persistent customer keyboard.
 *
 * Telegram allows exactly one `reply_markup` per message, so a screen carrying both context
 * inline buttons and `MAIN_REPLY_KEYBOARD` cannot deliver the keyboard on that same message —
 * and the keyboard is the part that survives navigation. It therefore rides a second message,
 * and only when a NEW message is created (never on an edit).
 *
 * That second message MUST STAY. A reply keyboard is chat-level state owned by the message that
 * set it; deleting that message retracts the keyboard in the client, so the bottom buttons flash
 * open and vanish. That was a real production bug: the delivery message used to be deleted right
 * after dispatch to keep the transcript clean, and the keyboard went with it. Do not reintroduce
 * the delete — if the bubble needs to be unobtrusive, keep the copy to one short line instead.
 *
 * The line earns its place: clients collapse the reply keyboard when the customer sends a
 * message, so a one-line pointer is what tells them the keyboard is available again.
 */
const PERSISTENT_KEYBOARD_PROMPT = "⌨️ Bàn phím nhanh ở dưới 👇";

/** Markup for the follow-up keyboard message, or null when this screen needs none. */
function pendingReplyKeyboardMarkup(message: PresentedMessage): ReplyKeyboardMarkup | null {
  if (!message.installPersistentKeyboard || !message.replyKeyboard) return null;
  if (message.buttons.length === 0) return null;
  return buildReplyKeyboard(message.replyKeyboard);
}

/**
 * Deliver the persistent customer keyboard on its own message after a new screen is created.
 *
 * Sent once per new message and deliberately never removed: this message is what holds the
 * keyboard open for the rest of the session.
 */
async function sendPersistentKeyboard(
  input: { chatId: string; messageThreadId?: number | null },
  markup: ReplyKeyboardMarkup,
  api: TelegramApi,
  trace: TelegramResponderTrace | undefined,
): Promise<void> {
  const result = await callTelegram("sendMessage", () =>
    api.sendMessage(input.chatId, PERSISTENT_KEYBOARD_PROMPT, {
      reply_markup: markup,
      ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {}),
    }),
  );
  traceTelegram(trace, {
    method: "sendMessage",
    persistent_keyboard: true,
    ...summarizeTelegramResult(result),
  });
}

/**
 * Read the Bot API `Message` identity out of a send/edit result. Callers persist this (a
 * durable panel owns exactly one message id); a missing id would otherwise be silently
 * forgotten and the panel would be reposted on the next update.
 */
function sentMessage(chatId: string, result: unknown): SentTelegramMessage | null {
  if (!result || typeof result !== "object" || !("message_id" in result)) return null;
  const messageId: unknown = result.message_id;
  if (typeof messageId !== "number" || !Number.isInteger(messageId)) return null;
  return { chatId, messageId: String(messageId) };
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

/**
 * Group chats register NO commerce commands. TIER20 SHOP is a private-chat bot: a group is
 * only a human community we link to, so the group command scope is cleared explicitly rather
 * than left with stale commands from an earlier release.
 */
export const TELEGRAM_GROUP_BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> =
  [];

/** Command menu only — never MenuButtonWebApp. Failures are non-fatal at worker boot. */
export async function ensureTelegramCommandMenu(input: {
  botToken: string;
  adminTelegramUserId?: number;
  client?: ApiClientOptions;
}): Promise<void> {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const api = new Api(input.botToken, input.client);
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
  client?: ApiClientOptions,
): TelegramDocumentSender {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const telegramApi = api ?? new Api(botToken, client);
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
  client?: ApiClientOptions,
): TelegramResponder {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("Invalid Telegram bot token");
  }
  const telegramApi = api ?? new Api(botToken, client);
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
      const pendingKeyboard = pendingReplyKeyboardMarkup(input.message);
      // An edit that Telegram rejects as "not modified" still leaves the caller owning that
      // message, so it is reported back rather than treated as a no-op.
      const unchanged = (): SentTelegramMessage | null =>
        input.messageId ? { chatId: input.chatId, messageId: input.messageId } : null;
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
        if (pendingKeyboard)
          await sendPersistentKeyboard(input, pendingKeyboard, telegramApi, trace);
        return sentMessage(input.chatId, result);
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
          return sentMessage(input.chatId, result) ?? unchanged();
        } catch (error) {
          if (classifyTelegramError(error) === "message-not-modified") return unchanged();
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
        if (pendingKeyboard)
          await sendPersistentKeyboard(input, pendingKeyboard, telegramApi, trace);
        return sentMessage(input.chatId, result);
      }
      if (input.messageId) {
        try {
          const result = await callTelegram("editMessageText", () =>
            telegramApi.editMessageText(input.chatId, Number(input.messageId), input.message.text, {
              reply_markup: editReplyMarkup,
            }),
          );
          traceTelegram(trace, { method: "editMessageText", ...summarizeTelegramResult(result) });
          return sentMessage(input.chatId, result) ?? unchanged();
        } catch (error) {
          if (classifyTelegramError(error) === "message-not-modified") return unchanged();
          if (classifyTelegramError(error) !== "non-editable-or-missing") throw error;
        }
        if (typeof telegramApi.editMessageCaption === "function") {
          try {
            const result = await callTelegram("editMessageCaption", () =>
              telegramApi.editMessageCaption(input.chatId, Number(input.messageId), {
                caption: input.message.text,
                reply_markup: editReplyMarkup,
              }),
            );
            traceTelegram(trace, {
              method: "editMessageCaption",
              ...summarizeTelegramResult(result),
            });
            return sentMessage(input.chatId, result) ?? unchanged();
          } catch (captionError) {
            if (classifyTelegramError(captionError) === "message-not-modified") return unchanged();
            if (classifyTelegramError(captionError) !== "non-editable-or-missing")
              throw captionError;
          }
        }
      }
      const result = await callTelegram("sendMessage", () =>
        telegramApi.sendMessage(input.chatId, input.message.text, {
          reply_markup: replyMarkup,
          ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {}),
        }),
      );
      traceTelegram(trace, { method: "sendMessage", ...summarizeTelegramResult(result) });
      if (pendingKeyboard) await sendPersistentKeyboard(input, pendingKeyboard, telegramApi, trace);
      return sentMessage(input.chatId, result);
    },
  };
}
