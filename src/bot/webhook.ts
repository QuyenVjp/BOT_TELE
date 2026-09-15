import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type {
  AcceptTelegramResult,
  TelegramChatType,
  TelegramCommandEnvelope,
} from "../infrastructure/inbox/telegram.js";
import type { LatencyMetrics } from "../infrastructure/observability/tracing.js";
import { verifyTelegramSecret } from "./middleware/security.js";
import { peekCallbackAction } from "./callback-codec.js";
import { CUSTOMER_COPY } from "./presenters/customer.js";

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
      title?: string;
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
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      from?: {
        id: number;
        is_bot?: boolean;
        username?: string;
      };
      text?: string;
    };
    new_chat_members?: Array<{
      id: number;
      is_bot?: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
    }>;
  };
  callback_query?: {
    id: string;
    from?: {
      id: number;
      is_bot?: boolean;
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
  inline_query?: {
    id: string;
    from: {
      id: number;
      is_bot?: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    query: string;
    offset: string;
    chat_type?: string;
  };
  chosen_inline_result?: {
    result_id: string;
    from: {
      id: number;
      is_bot?: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    query: string;
    inline_message_id?: string;
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
export const ROOT_PRODUCT_DRAFT_TEXT_STEPS = [
  "name",
  "sku",
  "description",
  "variant",
  "deliveryConfig",
  "variantName",
  "price",
  "inventoryFields",
  "threshold",
  "initialQuantity",
  "serviceInstructions",
] as const;

export type RootProductDraftTextStep = (typeof ROOT_PRODUCT_DRAFT_TEXT_STEPS)[number];

const ROOT_PRODUCT_DRAFT_TEXT_STEP_SET = new Set<string>(ROOT_PRODUCT_DRAFT_TEXT_STEPS);

export function isRootProductDraftTextStep(step: string): step is RootProductDraftTextStep {
  return ROOT_PRODUCT_DRAFT_TEXT_STEP_SET.has(step);
}

export interface RootProductDraftTextIngress {
  adminTelegramUserId: number;
  activeStep(telegramUserId: string): Promise<RootProductDraftTextStep | null>;
}

export interface AdminInventoryImportTextIngress {
  adminTelegramUserId: number;
  isActive(telegramUserId: string): Promise<boolean>;
}

/**
 * In-place product content editing (goal §81). Like the inventory-import context, a non-draft
 * admin input is not a "safe message" by itself, so the ingress has to vouch for it: without this
 * the text is dropped before the dispatcher ever sees it and the flow is unreachable.
 */
export interface AdminProductContentEditIngress {
  adminTelegramUserId: number;
  isActive(telegramUserId: string): Promise<boolean>;
}

export interface AdminWarrantyAdjustTextIngress {
  adminTelegramUserId: number;
  isActive(telegramUserId: string): Promise<boolean>;
}

/**
 * The owner-prompt free-text context (production-remediation screens): the publication
 * evidence prompt, the discrepancy note prompt and the outbox-orphan note prompt each ask
 * the owner to type one line. As with the other admin inputs, raw text is dropped before
 * the dispatcher ever sees it, so the ingress has to vouch for it — and only while one of
 * those prompts is actually pending.
 */
export interface AdminOwnerPromptTextIngress {
  adminTelegramUserId: number;
  isActive(telegramUserId: string): Promise<boolean>;
}

export interface TelegramWebhookOptions {
  path: string;
  secretToken: string;
  inbox: UpdateInbox;
  rootProductDraftText?: RootProductDraftTextIngress;
  inventoryImportText?: AdminInventoryImportTextIngress;
  productContentEditText?: AdminProductContentEditIngress;
  /** Goal §26: the owner's typed refund adjustment, admitted only while the prompt is pending. */
  warrantyRefundAdjustText?: AdminWarrantyAdjustTextIngress;
  /** Publication evidence / disposition notes; admitted only while one of those prompts is pending. */
  ownerPromptText?: AdminOwnerPromptTextIngress;
  /** Goal §28: the search prompt's one-shot permission for a typed query. */
  customerSearchQuery?: CustomerSearchQueryIngress;
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
      ? await normalizeTelegramUpdate(
          update,
          options.rootProductDraftText,
          options.inventoryImportText,
          options.productContentEditText,
          options.warrantyRefundAdjustText,
          options.ownerPromptText,
          options.customerSearchQuery,
        )
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
  inventoryImportText?: AdminInventoryImportTextIngress,
  productContentEditText?: AdminProductContentEditIngress,
  warrantyRefundAdjustText?: AdminWarrantyAdjustTextIngress,
  ownerPromptText?: AdminOwnerPromptTextIngress,
  customerSearchQuery?: CustomerSearchQueryIngress,
): Promise<TelegramCommandEnvelope | null> {
  if (
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    update.update_id > 0x7fffffff
  )
    return null;
  const actor =
    update.message?.from ??
    update.callback_query?.from ??
    update.inline_query?.from ??
    update.chosen_inline_result?.from;
  const actorId = actor?.id;
  if (!actorId || !Number.isSafeInteger(actorId) || actorId <= 0 || actor?.is_bot) return null;
  if (update.inline_query) {
    const actorUsername = normalizeUsernameMetadata(actor.username);
    return {
      actorUserId: String(actorId),
      ...(actorUsername ? { actorUsername } : {}),
      chatId: String(actorId),
      chatType: "private",
      messageId: null,
      action: "CATALOG",
      inlineQuery: {
        id: update.inline_query.id,
        query: update.inline_query.query.normalize("NFC").trim(),
        offset: update.inline_query.offset,
        ...(update.inline_query.chat_type ? { chatType: update.inline_query.chat_type } : {}),
      },
      ...(actor.first_name ? { firstName: actor.first_name } : {}),
      ...(actor.last_name ? { lastName: actor.last_name } : {}),
      ...(actor.language_code ? { languageCode: actor.language_code } : {}),
    };
  }
  if (update.chosen_inline_result) {
    const actorUsername = normalizeUsernameMetadata(actor.username);
    return {
      actorUserId: String(actorId),
      ...(actorUsername ? { actorUsername } : {}),
      chatId: String(actorId),
      chatType: "private",
      messageId: null,
      action: "CATALOG",
      chosenInlineResult: {
        resultId: update.chosen_inline_result.result_id,
        query: update.chosen_inline_result.query.normalize("NFC").trim(),
        ...(update.chosen_inline_result.inline_message_id
          ? { inlineMessageId: update.chosen_inline_result.inline_message_id }
          : {}),
      },
      ...(actor.first_name ? { firstName: actor.first_name } : {}),
      ...(actor.last_name ? { lastName: actor.last_name } : {}),
    };
  }
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  const rawChatType = chat?.type ?? "private";
  const chatType: TelegramChatType =
    rawChatType === "group" || rawChatType === "supergroup" ? rawChatType : "private";
  const chatId = chat?.id ?? actorId;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  if (update.message?.new_chat_members) {
    const newMembers = update.message.new_chat_members.filter((m) => !m.is_bot);
    if (newMembers.length > 0) {
      const actorUsername = normalizeUsernameMetadata(actor.username);
      return {
        actorUserId: String(actorId),
        ...(actorUsername ? { actorUsername } : {}),
        chatId: String(chatId),
        chatType,
        messageId: String(update.message.message_id),
        ...(update.message.message_thread_id
          ? { messageThreadId: update.message.message_thread_id }
          : {}),
        action: "CATALOG",
        newChatMembers: newMembers.map((m) => ({
          id: m.id,
          firstName: m.first_name,
          isBot: false,
        })),
      };
    }
  }
  const callbackData = update.callback_query?.data;
  if (callbackData && Buffer.byteLength(callbackData, "utf8") > 64) return null;

  const text = update.message?.text ?? "";
  const commandInfo = extractTelegramCommand(text, update.message?.entities);
  const command = commandInfo?.command;
  const searchQuery = commandInfo
    ? normalizeCommandArgument(command, text.slice(commandInfo.rawLength))
    : null;
  let normalizedMessageText: {
    text: string;
    rootProductDraftText?: true;
    inventoryImportText?: true;
    productContentEditText?: true;
    warrantyRefundAdjustText?: true;
    ownerPromptText?: true;
  } | null = null;
  const isGroup = chatType === "group" || chatType === "supergroup";
  const isMentioned = Boolean(
    text.toLowerCase().includes("@tier20ai_bot") ||
    update.message?.entities?.some(
      (e) =>
        e.type === "mention" &&
        e.offset !== undefined &&
        e.length !== undefined &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() === "@tier20ai_bot",
    ),
  );
  const isReplyToBot = Boolean(update.message?.reply_to_message?.from?.is_bot);
  const GROUP_COMMANDS: Record<string, true> = {
    "/shop": true,
    "/tim": true,
    "/hot": true,
    "/new": true,
    "/stock": true,
    "/support": true,
    "/orders": true,
    "/wallet": true,
    "/warranty": true,
  };
  if (isGroup && command && !GROUP_COMMANDS[command]) {
    return null;
  }
  if (isGroup && !command && !isMentioned && !isReplyToBot) {
    return null;
  }
  if (isGroup && !command && (isMentioned || isReplyToBot)) {
    const cleanText = text
      .replace(/@tier20ai_bot/gi, "")
      .normalize("NFC")
      .trim();
    if (cleanText.length > 0 && isSafeDraftProse(cleanText, 1000)) {
      normalizedMessageText = { text: cleanText };
    }
  } else {
    normalizedMessageText = await normalizeSafeMessageText(text, command, {
      actorId,
      chatId: String(
        update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? actorId,
      ),
      chatType,
      ...(customerSearchQuery ? { customerSearchQuery } : {}),
      ...(rootProductDraftText ? { rootProductDraftText } : {}),
      ...(inventoryImportText ? { inventoryImportText } : {}),
      ...(productContentEditText ? { productContentEditText } : {}),
      ...(warrantyRefundAdjustText ? { warrantyRefundAdjustText } : {}),
      ...(ownerPromptText ? { ownerPromptText } : {}),
    });
  }
  const action =
    isGroup && (isMentioned || isReplyToBot) && !command
      ? ("CATALOG" as const)
      : normalizedMessageText?.inventoryImportText
        ? ("ADMIN" as const)
        : normalizedMessageText?.warrantyRefundAdjustText
          ? ("ADMIN" as const)
          : normalizedMessageText?.productContentEditText
            ? ("ADMIN" as const)
            : normalizedMessageText?.ownerPromptText
              ? ("ADMIN" as const)
              : normalizedMessageText?.rootProductDraftText
                ? ("ADMIN" as const)
                : classifyAction(callbackData, command);
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
    chatType,
    ...(update.message?.message_thread_id
      ? { messageThreadId: update.message.message_thread_id }
      : {}),
    ...(update.message?.reply_to_message
      ? {
          replyToMessageId: String(update.message.reply_to_message.message_id),
          replyToText: update.message.reply_to_message.text ?? null,
          replyToBot: Boolean(update.message.reply_to_message.from?.is_bot),
        }
      : {}),
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
    ...(normalizedMessageText?.inventoryImportText ? { inventoryImportText: true as const } : {}),
    // Without this spread the ingress decision is computed and then thrown away, so the routing
    // marker never reaches the dispatcher and the vouched text is claimed by a generic handler.
    ...(normalizedMessageText?.productContentEditText
      ? { productContentEditText: true as const }
      : {}),
    ...(normalizedMessageText?.warrantyRefundAdjustText
      ? { warrantyRefundAdjustText: true as const }
      : {}),
    ...(normalizedMessageText?.ownerPromptText ? { ownerPromptText: true as const } : {}),
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
  if (callbackData?.startsWith("delivery:open")) return "CATALOG";
  if (command === "/support" || command === "/warranty") return "SUPPORT";
  if (
    command === "/admin" ||
    command === "/products" ||
    command === "/inventory" ||
    command === "/customers" ||
    command === "/broadcast" ||
    command === "/health"
  )
    return "ADMIN";
  if (command === "/cancel") return "CANCEL";
  if (
    command === "/start" ||
    command === "/catalog" ||
    command === "/shop" ||
    command === "/search" ||
    command === "/tim" ||
    command === "/hot" ||
    command === "/new" ||
    command === "/stock" ||
    command === "/orders" ||
    command === "/help" ||
    command === "/settings"
  )
    return "CATALOG";
  if (command === "/account" || command === "/wallet" || command === "/topup" || command === "/pay")
    return "WALLET";
  return "UNKNOWN";
}

const SAFE_MESSAGE_TEXT: Record<string, true> = {
  [CUSTOMER_COPY.restock]: true,
  [CUSTOMER_COPY.notifications]: true,
  [CUSTOMER_COPY.shopUpdates]: true,
  [CUSTOMER_COPY.purchaseActivity]: true,
  [CUSTOMER_COPY.browse]: true,
  [CUSTOMER_COPY.account]: true,
  [CUSTOMER_COPY.topup]: true,
  [CUSTOMER_COPY.back]: true,
  [CUSTOMER_COPY.orders]: true,
  [CUSTOMER_COPY.warranty]: true,
  [CUSTOMER_COPY.support]: true,
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
    chatId: string;
    chatType: string;
    customerSearchQuery?: CustomerSearchQueryIngress;
    rootProductDraftText?: RootProductDraftTextIngress;
    inventoryImportText?: AdminInventoryImportTextIngress;
    productContentEditText?: AdminProductContentEditIngress;
    warrantyRefundAdjustText?: AdminWarrantyAdjustTextIngress;
    ownerPromptText?: AdminOwnerPromptTextIngress;
  },
): Promise<{
  text: string;
  rootProductDraftText?: true;
  inventoryImportText?: true;
  productContentEditText?: true;
  warrantyRefundAdjustText?: true;
  ownerPromptText?: true;
} | null> {
  if (!text || command) return null;
  const normalized = text.normalize("NFC").trim();
  if (SAFE_MESSAGE_TEXT[normalized]) return { text: normalized };
  // Only while the customer is actually looking at the search prompt, and only once: any other
  // raw text stays dropped, exactly as the ingress contract has always required.
  if (context.customerSearchQuery && context.chatType === "private") {
    const candidate = normalizeCustomerSearchQuery(normalized);
    if (candidate && (await context.customerSearchQuery.consume(context.chatId))) {
      return { text: candidate };
    }
  }
  if (
    context.inventoryImportText &&
    context.chatType === "private" &&
    context.actorId === context.inventoryImportText.adminTelegramUserId
  ) {
    const active = await context.inventoryImportText.isActive(String(context.actorId));
    if (active) {
      const sanitized = sanitizeInventoryImportText(normalized);
      if (sanitized && isSafeInventoryImportText(sanitized)) {
        return { text: sanitized, inventoryImportText: true };
      }
    }
  }
  if (
    context.productContentEditText &&
    context.chatType === "private" &&
    context.actorId === context.productContentEditText.adminTelegramUserId
  ) {
    const active = await context.productContentEditText.isActive(String(context.actorId));
    if (active) {
      const sanitized = sanitizeProductContentText(normalized);
      if (sanitized) return { text: sanitized, productContentEditText: true };
    }
  }
  if (
    context.warrantyRefundAdjustText &&
    context.chatType === "private" &&
    context.actorId === context.warrantyRefundAdjustText.adminTelegramUserId
  ) {
    const active = await context.warrantyRefundAdjustText.isActive(String(context.actorId));
    if (active) {
      const sanitized = sanitizeProductContentText(normalized);
      if (sanitized) return { text: sanitized, warrantyRefundAdjustText: true };
    }
  }
  if (
    context.ownerPromptText &&
    context.chatType === "private" &&
    context.actorId === context.ownerPromptText.adminTelegramUserId
  ) {
    const active = await context.ownerPromptText.isActive(String(context.actorId));
    if (active) {
      const sanitized = sanitizeProductContentText(normalized);
      if (sanitized) return { text: sanitized, ownerPromptText: true };
    }
  }
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

const MAX_DRAFT_PROSE_CHARS = 2000;

/** Trim, strip control/format characters, and cap — mirrors the service's 2000-character limit. */
function sanitizeProductContentText(normalized: string): string | null {
  let out = "";
  for (const ch of normalized) {
    if (/[\p{Cc}\p{Cf}\0]/u.test(ch)) continue;
    out += ch;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_DRAFT_PROSE_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_DRAFT_PROSE_CHARS);
}

function isSafeDraftProse(normalized: string, maxBytes: number): boolean {
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_DRAFT_PROSE_CHARS &&
    Buffer.byteLength(normalized, "utf8") <= maxBytes &&
    !/[\p{Cc}\p{Cf}\0]/u.test(normalized)
  );
}

const MAX_INVENTORY_IMPORT_TEXT_BYTES = 64 * 1024;
const MAX_INVENTORY_IMPORT_LINES = 500;

function sanitizeInventoryImportText(normalized: string): string {
  let out = "";
  for (const ch of normalized) {
    if (ch === "\r" || ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    if (/[\p{Cc}\p{Cf}\0]/u.test(ch)) continue;
    out += ch;
  }
  return out.trim();
}

function isSafeInventoryImportText(normalized: string): boolean {
  if (
    normalized.length === 0 ||
    normalized.length > MAX_INVENTORY_IMPORT_TEXT_BYTES ||
    Buffer.byteLength(normalized, "utf8") > MAX_INVENTORY_IMPORT_TEXT_BYTES
  ) {
    return false;
  }
  const lines = normalized.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0 || lines.length > MAX_INVENTORY_IMPORT_LINES) {
    return false;
  }
  for (const ch of normalized) {
    if (ch === "\r" || ch === "\n" || ch === "\t") continue;
    if (/[\p{Cc}\p{Cf}\0]/u.test(ch)) return false;
  }
  return true;
}

/**
 * Goal §28 — the search prompt invites the customer to send a product name, so a plain query has
 * to survive the ingress. Everything the customer types that is not a known label was dropped
 * here (the update arrived as UNKNOWN with no text), which made the prompt a dead end: only
 * `/search <term>` worked. This admits a conservative query and nothing else — no commands, no
 * URLs, no handles, no multi-line text, no phone-number-shaped input.
 */
/** One-shot permission created by the search prompt and consumed by the query it invites. */
export interface CustomerSearchQueryIngress {
  consume(chatId: string): Promise<boolean>;
}

function normalizeCustomerSearchQuery(value: string): string | null {
  if (value.length < 2 || value.length > 64) return null;
  if (value.startsWith("/")) return null;
  // Every reply-keyboard label the bot installs carries a leading emoji, so an emoji-bearing
  // message is a button the customer tapped — not a product name. Without this the labels that
  // are not in SAFE_MESSAGE_TEXT (e.g. the closed-store key) would be swallowed as a search.
  if (/\p{Extended_Pictographic}/u.test(value)) return null;
  if (/[\n\r\t]/.test(value)) return null;
  if (/https?:\/\/|www\./iu.test(value)) return null;
  if (/[@#]/u.test(value)) return null;
  if (/^[+()0-9][0-9 ().-]{5,}$/u.test(value)) return null;
  return value;
}

function normalizeRootProductDraftText(
  normalized: string,
  step: RootProductDraftTextStep,
): string | null {
  switch (step) {
    case "name":
    case "variantName":
      return isSafeDraftProse(normalized, 200) ? normalized : null;
    case "description":
    case "deliveryConfig":
    case "serviceInstructions":
      return isSafeDraftProse(normalized, 8000) ? normalized : null;
    case "sku":
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(normalized) ? normalized : null;
    case "variant": {
      const separator = normalized.indexOf("|");
      if (separator <= 0) return null;
      const name = normalized.slice(0, separator).trim();
      const price = normalized.slice(separator + 1).trim();
      if (!name || !price || !isSafeDraftProse(name, 200)) return null;
      return /^\d{1,15}$/u.test(price.replace(/[.,]/g, "")) ? normalized : null;
    }
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
