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

export interface TelegramResponder {
  send(input: {
    chatId: string;
    messageId: string | null;
    callbackQueryId?: string;
    message: PresentedMessage;
  }): Promise<void>;
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
  | "editMessageMedia"
  | "editMessageText"
  | "sendDocument"
  | "sendPhoto"
  | "sendMessage"
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
      if (button.webAppUrl) inline.webApp(button.text, button.webAppUrl);
      else inline.text(button.text, button.callbackData);
    }
    inline.row();
  }
  return message.replyKeyboard ? buildReplyKeyboard(message.replyKeyboard) : inline;
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
  return {
    async send(input) {
      if (input.callbackQueryId) {
        await telegramApi.answerCallbackQuery(input.callbackQueryId).catch(() => undefined);
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
        telegramApi.sendMessage(input.chatId, input.message.text, { reply_markup: replyMarkup }),
      );
      traceTelegram(trace, { method: "sendMessage", ...summarizeTelegramResult(result) });
    },
  };
}
