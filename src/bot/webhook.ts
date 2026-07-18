import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type {
  AcceptTelegramResult,
  TelegramCommandEnvelope,
} from "../infrastructure/inbox/telegram.js";
import { verifyTelegramSecret } from "./middleware/security.js";
import { peekCallbackAction } from "./callback-codec.js";

/**
 * Telegram webhook ingress (telegram-ux.md Ingress; SR-004, FR-010, FR-024).
 *
 * Processing order is deliberate and fail-closed:
 *   1. verify the secret token (constant time) — reject 401 before any parse of
 *      business meaning;
 *   2. dedupe by `update_id` — a replayed update acks 200 but never re-runs the
 *      handler (FR-010 idempotency);
 *   3. per-user rate budget — throttle 429 while leaving other users unaffected
 *      (FR-024 abuse control);
 *   4. dispatch to the business handler.
 *
 * Body-size limits are enforced by Fastify's `bodyLimit` (413) before the route
 * body runs, so oversized payloads never reach this handler.
 */

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** Minimal shape of a Telegram update we rely on at the ingress boundary. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    from?: { id: number; is_bot?: boolean; username?: string };
    chat?: { id: number; type?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: { id: number; username?: string };
    data?: string;
    message?: { chat?: { id: number; type?: string }; message_id?: number };
  };
}

export type UpdateHandler = (update: TelegramUpdate) => Promise<void>;

/** Dedupe port: records/queries whether an update_id was already accepted. */
export interface UpdateInbox {
  accept(input: {
    sourceEventId: string;
    rawHash: string;
    envelope: TelegramCommandEnvelope;
  }): Promise<AcceptTelegramResult>;
}

/**
 * In-memory dedupe inbox for tests/dev. Production uses the durable
 * `webhook_inbox` table (unique on (source, source_event_id)); this port keeps
 * the same "claim once" contract.
 */
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

export interface TelegramWebhookOptions {
  path: string;
  secretToken: string;
  inbox: UpdateInbox;
}

/** Derive the rate-limit principal from an update (numeric user id, never username). */
/**
 * Coerce the Fastify body (string | object | unknown) into a TelegramUpdate.
 * Returns undefined for non-JSON / non-object payloads so the caller can ack.
 */
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

export async function registerTelegramWebhook(
  app: FastifyInstance,
  options: TelegramWebhookOptions,
): Promise<void> {
  const { path, secretToken, inbox } = options;

  app.post(path, async (request, reply) => {
    // 1. Secret token (constant-time) before anything else.
    const presented = request.headers[SECRET_HEADER];
    const headerValue = Array.isArray(presented) ? presented[0] : presented;
    if (!verifyTelegramSecret(headerValue, secretToken)) {
      return reply.code(401).send({ ok: false });
    }

    // The app-level content-type parser preserves the raw body as a string so
    // SePay HMAC verification can sign exact bytes. Parse here for Telegram.
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const update = coerceUpdate(rawBody);
    const normalized = update ? normalizeTelegramUpdate(update) : null;
    if (!update || !normalized) {
      // Malformed shape — ack 200 so Telegram stops retrying a poison update,
      // but do nothing (nothing to dedupe or dispatch).
      return reply.code(200).send({ ok: true });
    }

    try {
      const accepted = await inbox.accept({
        sourceEventId: String(update.update_id),
        rawHash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
        envelope: normalized,
      });
      if (accepted.kind === "DUPLICATE") {
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      if (accepted.kind === "MUTATION") {
        return reply.code(200).send({ ok: false, discrepancy: true });
      }
      return reply.code(200).send({ ok: true, queued: true });
    } catch {
      reply.header("retry-after", "1");
      return reply.code(503).send({ ok: false, retryable: true });
    }
  });
}

function normalizeTelegramUpdate(update: TelegramUpdate): TelegramCommandEnvelope | null {
  if (
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    update.update_id > 0x7fffffff
  ) {
    return null;
  }
  const actor = update.message?.from ?? update.callback_query?.from;
  const actorId = actor?.id;
  if (!actorId || !Number.isSafeInteger(actorId) || actorId <= 0 || update.message?.from?.is_bot) {
    return null;
  }
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  const chatId = chat?.id ?? actorId;
  if (!Number.isSafeInteger(chatId) || chatId === 0 || (chat?.type ?? "private") !== "private") {
    return null;
  }
  const callbackData = update.callback_query?.data;
  if (callbackData && Buffer.byteLength(callbackData, "utf8") > 64) return null;
  const text = update.message?.text ?? "";
  const command = text.startsWith("/") ? text.split(/\s+/, 1)[0]!.toLowerCase() : undefined;
  const searchQuery =
    command === "/search" ? normalizeSearchQuery(text.slice(command.length)) : null;
  const action = classifyAction(callbackData, command);
  const actorUsername = normalizeUsernameMetadata(actor.username);
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
    ...(searchQuery ? { searchQuery } : {}),
  };
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
    ) {
      return "SUPPORT";
    }
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
  if (command === "/start" || command === "/catalog" || command === "/search") return "CATALOG";
  return "UNKNOWN";
}

function normalizeSearchQuery(value: string): string | null {
  const normalized = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized.length > 0 ? normalized : null;
}
