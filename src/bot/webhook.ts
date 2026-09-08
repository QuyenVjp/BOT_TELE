import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type {
  AcceptTelegramResult,
  TelegramCommandEnvelope,
} from "../infrastructure/inbox/telegram.js";
import type { LatencyMetrics } from "../infrastructure/observability/tracing.js";
import { verifyTelegramSecret } from "./middleware/security.js";
import { peekCallbackAction } from "./callback-codec.js";

/** Telegram webhook ingress (telegram-ux.md Ingress; SR-004, FR-010, FR-024). */

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    from?: {
      id: number;
      is_bot?: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    chat?: {
      id: number;
      type?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    contact?: {
      phone_number?: string;
      first_name?: string;
      last_name?: string;
      user_id?: number;
      vcard?: string;
    };
    text?: string;
    entities?: Array<{ type?: string; offset?: number; length?: number }>;
    document?: {
      file_id?: string;
      file_unique_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    data?: string;
    message?: {
      chat?: {
        id: number;
        type?: string;
        username?: string;
        first_name?: string;
        last_name?: string;
      };
      message_id?: number;
    };
  };
}

export type UpdateHandler = (update: TelegramUpdate) => Promise<void>;

export interface UpdateInbox {
  accept(input: {
    sourceEventId: string;
    rawHash: string;
    envelope: TelegramCommandEnvelope;
  }): Promise<AcceptTelegramResult>;
}

export function createInMemoryUpdateInbox(): UpdateInbox {
  const seen = new Map<string, { id: string; rawHash: string }>();
  return {
    async accept(input) {
      const previous = seen.get(input.sourceEventId);
      if (previous) {
        return previous.rawHash === input.rawHash
          ? { kind: "DUPLICATE", id: previous.id }
          : { kind: "MUTATION", id: previous.id };
      }
      const id = `memory:${input.sourceEventId}`;
      seen.set(input.sourceEventId, { id, rawHash: input.rawHash });
      return { kind: "ACCEPTED", id };
    },
  };
}
export type RootProductDraftTextStep =
  "name" | "sku" | "variantName" | "price" | "inventoryFields" | "threshold" | "initialQuantity";

export interface RootProductDraftTextIngress {
  adminTelegramUserId: number;
  activeStep(telegramUserId: string): Promise<RootProductDraftTextStep | null>;
}

export interface TelegramWebhookOptions {
  path: string;
  secretToken: string;
  inbox: UpdateInbox;
  rootProductDraftText?: RootProductDraftTextIngress;
  metrics?: LatencyMetrics;
}

export async function registerTelegramWebhook(
  app: FastifyInstance,
  options: TelegramWebhookOptions,
): Promise<void> {
  const { path, secretToken, inbox } = options;

  app.post(path, async (request, reply) => {
    const presented = request.headers[SECRET_HEADER];
    const headerValue = Array.isArray(presented) ? presented[0] : presented;
    if (!verifyTelegramSecret(headerValue, secretToken)) {
      return reply.code(401).send({ ok: false });
    }

    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const update = coerceUpdate(rawBody);
    const normalized = update
      ? await normalizeTelegramUpdate(update, options.rootProductDraftText)
      : null;
    if (!update || !normalized) {
      return reply.code(200).send({ ok: true });
    }

    try {
      const accepted = await inbox.accept({
        sourceEventId: String(update.update_id),
        rawHash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
        envelope: normalized,
      });
      if (accepted.kind === "DUPLICATE") {
        if (update.callback_query?.id) {
          return reply
            .code(200)
            .send({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id });
        }
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      if (accepted.kind === "MUTATION") {
        if (update.callback_query?.id) {
          return reply.code(200).send({
            method: "answerCallbackQuery",
            callback_query_id: update.callback_query.id,
            text: "Yêu cầu không hợp lệ, vui lòng mở lại menu.",
            show_alert: true,
          });
        }
        return reply.code(200).send({ ok: false, discrepancy: true });
      }
      if (update.callback_query?.id) {
        return reply
          .code(200)
          .send({ method: "answerCallbackQuery", callback_query_id: update.callback_query.id });
      }
      return reply.code(200).send({ ok: true, queued: true });
    } catch {
      reply.header("retry-after", "1");
      return reply.code(503).send({ ok: false, retryable: true });
    }
  });
}

function coerceUpdate(body: unknown): TelegramUpdate | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") {
    if (body.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object") return parsed as TelegramUpdate;
      return undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof body === "object") return body as TelegramUpdate;
  return undefined;
}

async function normalizeTelegramUpdate(
  update: TelegramUpdate,
  rootProductDraftText?: RootProductDraftTextIngress,
): Promise<TelegramCommandEnvelope | null> {
  if (
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    update.update_id > 0x7fffffff
  )
    return null;
  const actor = update.message?.from ?? update.callback_query?.from;
  const actorId = actor?.id;
  if (!actorId || !Number.isSafeInteger(actorId) || actorId <= 0 || update.message?.from?.is_bot)
    return null;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  const chatId = chat?.id ?? actorId;
  if (!Number.isSafeInteger(chatId) || chatId === 0 || (chat?.type ?? "private") !== "private")
    return null;
  const callbackData = update.callback_query?.data;
  if (callbackData && Buffer.byteLength(callbackData, "utf8") > 64) return null;

  const text = update.message?.text ?? "";
  const commandInfo = extractTelegramCommand(text, update.message?.entities);
  const command = commandInfo?.command;
  const searchQuery = commandInfo
    ? normalizeCommandArgument(command, text.slice(commandInfo.rawLength))
    : null;
  const normalizedMessageText = await normalizeSafeMessageText(text, command, {
    actorId,
    chatType: chat?.type ?? "private",
    ...(rootProductDraftText ? { rootProductDraftText } : {}),
  });
  const action = classifyAction(callbackData, command);
  const actorUsername = normalizeUsernameMetadata(actor.username);
  const contact = update.message?.contact;
  const contactPhoneNumber =
    contact && contact.user_id === actorId && typeof contact.phone_number === "string"
      ? contact.phone_number
      : undefined;

  const document = update.message?.document;
  const normalizedDocument =
    document &&
    typeof document.file_id === "string" &&
    typeof document.file_name === "string" &&
    typeof document.mime_type === "string"
      ? {
          fileId: document.file_id,
          ...(typeof document.file_unique_id === "string"
            ? { fileUniqueId: document.file_unique_id }
            : {}),
          filename: document.file_name,
          mimeType: document.mime_type,
          ...(typeof document.file_size === "number" ? { fileSize: document.file_size } : {}),
        }
      : null;
  return {
    actorUserId: String(actorId),
    ...(actorUsername ? { actorUsername } : {}),
    chatId: String(chatId),
    chatType: "private",
    messageId:
      update.message?.message_id || update.callback_query?.message?.message_id
        ? String(update.message?.message_id ?? update.callback_query?.message?.message_id)
        : null,
    ...(update.callback_query?.id ? { callbackQueryId: update.callback_query.id } : {}),
    action,
    ...(callbackData ? { callbackData } : {}),
    ...(command ? { command } : {}),
    ...(normalizedMessageText?.text ? { messageText: normalizedMessageText.text } : {}),
    ...(normalizedMessageText?.rootProductDraftText ? { rootProductDraftText: true as const } : {}),
    ...(actor.first_name ? { firstName: actor.first_name } : {}),
    ...(actor.last_name ? { lastName: actor.last_name } : {}),
    ...(actor.language_code ? { languageCode: actor.language_code } : {}),
    ...(contactPhoneNumber ? { contactPhoneNumber } : {}),
    ...(contactPhoneNumber ? { contactSharedAt: new Date().toISOString() } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(normalizedDocument ? { document: normalizedDocument } : {}),
  };
}

function extractTelegramCommand(
  text: string,
  entities: Array<{ type?: string; offset?: number; length?: number }> | undefined,
): { command: string; rawLength: number } | undefined {
  const commandEntity = entities?.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  const rawCommand = commandEntity
    ? text.slice(0, commandEntity.length)
    : text.startsWith("/")
      ? text.split(/\s+/, 1)[0]!
      : "";
  if (!rawCommand.startsWith("/")) return undefined;
  const bare = rawCommand.slice(1).split("@", 1)[0]?.trim().toLowerCase();
  if (!bare) return undefined;
  return { command: `/${bare}`, rawLength: rawCommand.length };
}

function normalizeUsernameMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(normalized) ? normalized : null;
}

function classifyAction(
  callbackData: string | undefined,
  command: string | undefined,
): TelegramCommandEnvelope["action"] {
  if (callbackData?.startsWith("buy:")) return "BUY_NOW";
  if (callbackData?.startsWith("cb:")) {
    const action = peekCallbackAction(callbackData);
    if (action === "PAYMENT_REFRESH") return "PAYMENT_CHECK";
    if (action === "PAYMENT_CANCEL") return "CANCEL";
    if (
      action === "SUPPORT_MENU" ||
      action === "SUPPORT_REASON" ||
      action === "SUPPORT_TICKET_VIEW"
    )
      return "SUPPORT";
    if (action === "ADMIN_COMMAND") return "ADMIN";
    if (action) return "CATALOG";
    return "UNKNOWN";
  }
  if (callbackData?.startsWith("pay:refresh:")) return "PAYMENT_CHECK";
  if (callbackData?.startsWith("pay:cancel:")) return "CANCEL";
  if (callbackData?.startsWith("support:")) return "SUPPORT";
  if (callbackData?.startsWith("admin:")) return "ADMIN";
  if (callbackData?.startsWith("order:recover:")) return "PAID_ORDER_RECOVERY";
  if (command === "/support") return "SUPPORT";
  if (command === "/admin") return "ADMIN";
  if (command === "/cancel") return "CANCEL";
  if (command === "/start" || command === "/catalog" || command === "/search") return "CATALOG";
  if (command === "/account" || command === "/topup" || command === "/pay") return "WALLET";
  return "UNKNOWN";
}

const SAFE_MESSAGE_TEXT: Record<string, true> = {
  "🔔 Báo có hàng": true,
  "🔔 Cài đặt thông báo": true,
  "🛍 Cập nhật sản phẩm": true,
  "📣 Hoạt động mua hàng": true,
  "🌐 Mở cửa hàng": true,
  "👤 Tài khoản": true,
  "💰 Nạp ví": true,
  "↩️ Quay lại": true,
  "🧾 Đơn hàng": true,
  "🛟 Hỗ trợ": true,
};

function normalizeCommandArgument(command: string | undefined, value: string): string | null {
  if (
    command !== "/start" &&
    command !== "/search" &&
    command !== "/pay" &&
    command !== "/customer" &&
    command !== "/message_customer"
  )
    return null;
  const maxLength = command === "/message_customer" ? 1100 : 80;
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

async function normalizeSafeMessageText(
  text: string,
  command: string | undefined,
  context: {
    actorId: number;
    chatType: string;
    rootProductDraftText?: RootProductDraftTextIngress;
  },
): Promise<{ text: string; rootProductDraftText?: true } | null> {
  if (!text || command) return null;
  const normalized = text.normalize("NFC").trim();
  if (SAFE_MESSAGE_TEXT[normalized]) return { text: normalized };
  if (
    context.rootProductDraftText &&
    context.chatType === "private" &&
    context.actorId === context.rootProductDraftText.adminTelegramUserId
  ) {
    const step = await context.rootProductDraftText.activeStep(String(context.actorId));
    const productText = step ? normalizeRootProductDraftText(normalized, step) : null;
    if (productText) return { text: productText, rootProductDraftText: true };
  }
  return /^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}([.,])[0-9]{3}(?:\1[0-9]{3})*)$/u.test(normalized)
    ? { text: normalized }
    : null;
}

function normalizeRootProductDraftText(
  normalized: string,
  step: RootProductDraftTextStep,
): string | null {
  switch (step) {
    case "name":
    case "variantName":
      return Buffer.byteLength(normalized, "utf8") <= 200 && !/[\p{Cc}\p{Cf}\0]/u.test(normalized)
        ? normalized
        : null;
    case "sku":
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(normalized) ? normalized : null;
    case "inventoryFields": {
      const fields = normalized.split(",").map((part) => part.trim().toLowerCase());
      const allowed: Record<string, true> = {
        username: true,
        password: true,
        email: true,
        profile_url: true,
        note: true,
      };
      return fields.length > 0 && fields.every((field) => allowed[field]) ? fields.join(",") : null;
    }
    case "price":
    case "threshold":
    case "initialQuantity":
      return /^\d{1,15}$/u.test(normalized) ? normalized : null;
  }
}
