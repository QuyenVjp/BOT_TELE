import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  verifyTelegramSecret,
  normalizeInboundText,
  MAX_TEXT_LENGTH,
} from "../../src/bot/middleware/security.js";
import { registerTelegramWebhook, createInMemoryUpdateInbox } from "../../src/bot/webhook.js";

/**
 * T021 — Telegram ingress boundaries (SR-004, FR-010, FR-024).
 *
 * SR-004: documented size/shape boundaries — reject missing/invalid secret token
 *         and oversized bodies before any processing.
 * FR-010: duplicate/reordered updates are idempotent — dedupe by update_id so a
 *         replayed update never triggers the handler twice.
 * FR-024: per-user/action abuse controls, while an authenticated recovery route
 *         for paid orders/support is preserved.
 */

const SECRET = ["telegram", "webhook", "test", "secret"].join("-");
const WEBHOOK_PATH = "/telegram/webhook";
const BODY_LIMIT = 16 * 1024;

let app: FastifyInstance;
function buildUpdate(updateId: number, userId: number, text = "/start") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, username: "ignored_username" },
      chat: { id: userId, type: "private" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(/\s+/, 1)[0]!.length }]
        : undefined,
    },
  };
}

beforeEach(async () => {
  app = Fastify({ bodyLimit: BODY_LIMIT });
  await registerTelegramWebhook(app, {
    path: WEBHOOK_PATH,
    secretToken: SECRET,
    inbox: createInMemoryUpdateInbox(),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("secret token verification (SR-004)", () => {
  it("constant-time compare accepts the exact secret and rejects others", () => {
    expect(verifyTelegramSecret(SECRET, SECRET)).toBe(true);
    expect(verifyTelegramSecret("wrong", SECRET)).toBe(false);
    expect(verifyTelegramSecret(undefined, SECRET)).toBe(false);
    expect(verifyTelegramSecret("", SECRET)).toBe(false);
  });

  it("rejects an update with a missing secret header (401), no handler run", async () => {
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      payload: buildUpdate(1, 100),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an update with a wrong secret header (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": "nope" },
      payload: buildUpdate(1, 100),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts an update with the correct secret header (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: buildUpdate(1, 100),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("body size boundary (SR-004)", () => {
  it("rejects a body over the configured limit (413)", async () => {
    const huge = { update_id: 2, message: { text: "x".repeat(BODY_LIMIT + 1024) } };
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("update_id dedupe (FR-010)", () => {
  it("processes a given update_id exactly once even if replayed", async () => {
    const send = () =>
      app.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(42, 100),
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
  });
});

describe("asynchronous abuse-control boundary (FR-024)", () => {
  it("durably accepts a burst without holding HTTP open for business handling", async () => {
    const results: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(i, 200),
      });
      results.push(res.statusCode);
    }
    expect(results).toEqual([200, 200, 200, 200, 200]);
  });

  it("independent users have independent budgets", async () => {
    for (let i = 1; i <= 3; i++) {
      await app.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(i, 300),
      });
    }
    const other = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: buildUpdate(99, 400),
    });
    expect(other.statusCode).toBe(200);
  });
});

describe("input normalization (SR-004)", () => {
  it("NFC-normalizes and bounds inbound text length", () => {
    const decomposed = "é";
    expect(normalizeInboundText(decomposed)).toBe("é");

    const oversized = "a".repeat(MAX_TEXT_LENGTH + 50);
    expect(normalizeInboundText(oversized).length).toBe(MAX_TEXT_LENGTH);
  });
});

describe("root product draft text ingress", () => {
  it("preserves bounded root-active product metadata and suppresses other raw text", async () => {
    const accepted: unknown[] = [];
    const ingress = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(ingress, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          accepted.push(input.envelope);
          return { kind: "ACCEPTED", id: `accepted:${input.sourceEventId}` };
        },
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async (telegramUserId) =>
          telegramUserId === "123456789" ? "name" : null,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9001, 123456789, "CANARY P0 Inventory - KHONG BAN"),
      });
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9002, 987654321, "CANARY P0 Inventory - KHONG BAN"),
      });

      expect(accepted).toHaveLength(2);
      expect(accepted[0]).toMatchObject({
        messageText: "CANARY P0 Inventory - KHONG BAN",
        rootProductDraftText: true,
      });
      expect(accepted[1]).not.toHaveProperty("messageText");
    } finally {
      await ingress.close();
    }
  });

  it("marks numeric root-active price text as product draft text", async () => {
    const accepted: unknown[] = [];
    const ingress = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(ingress, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          accepted.push(input.envelope);
          return { kind: "ACCEPTED", id: `accepted:${input.sourceEventId}` };
        },
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async (telegramUserId) => (telegramUserId === "123456789" ? "price" : null),
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9004, 123456789, "10000"),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ messageText: "10000", rootProductDraftText: true });
    } finally {
      await ingress.close();
    }
  });

  it("marks configured inventory field names as root product draft text only at that step", async () => {
    const accepted: unknown[] = [];
    const ingress = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(ingress, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          accepted.push(input.envelope);
          return { kind: "ACCEPTED", id: `accepted:${input.sourceEventId}` };
        },
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async (telegramUserId) =>
          telegramUserId === "123456789" ? "inventoryFields" : null,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9005, 123456789, "username,password,email"),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        messageText: "username,password,email",
        rootProductDraftText: true,
      });
    } finally {
      await ingress.close();
    }
  });

  it("does not persist arbitrary root inventory paste without a product metadata step", async () => {
    const accepted: unknown[] = [];
    const ingress = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(ingress, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          accepted.push(input.envelope);
          return { kind: "ACCEPTED", id: `accepted:${input.sourceEventId}` };
        },
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async () => null,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9003, 123456789, "variant-1,secret-value"),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]).not.toHaveProperty("messageText");
      expect(JSON.stringify(accepted[0])).not.toContain("secret-value");
    } finally {
      await ingress.close();
    }
  });
});

describe("durable callback ACK", () => {
  function callbackUpdate(updateId: number, callbackId = "cb-1") {
    return {
      update_id: updateId,
      callback_query: {
        id: callbackId,
        from: { id: 100 },
        data: "menu:main",
        message: { message_id: 7, chat: { id: 100, type: "private" } },
      },
    };
  }

  it("returns answerCallbackQuery only after durable acceptance", async () => {
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: callbackUpdate(501, "callback-501"),
    });
    expect(res.json()).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "callback-501",
    });
  });

  it("does not ACK callback when the inbox enqueue fails", async () => {
    await app.close();
    app = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(app, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        accept: async () => {
          throw new Error("db down");
        },
      },
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: callbackUpdate(502, "callback-502"),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).not.toHaveProperty("method");
  });

  it("ACKs a duplicate callback after prior durable acceptance", async () => {
    const send = () =>
      app.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: callbackUpdate(503, "callback-503"),
      });
    await send();
    expect((await send()).json()).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "callback-503",
    });
  });

  it("ACKs a mutated callback without dispatching it", async () => {
    await app.close();
    app = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(app, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: { accept: async () => ({ kind: "MUTATION", id: "mutation-504" }) },
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: callbackUpdate(504, "callback-504"),
    });
    expect(res.json()).toMatchObject({
      method: "answerCallbackQuery",
      callback_query_id: "callback-504",
      show_alert: true,
    });
  });
});

describe("command normalization", () => {
  it("normalizes /admin@bot commands and captures verified profile/contact metadata", async () => {
    let seen: unknown = null;
    const localApp = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(localApp, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          seen = input.envelope;
          return { kind: "ACCEPTED", id: "abc" };
        },
      },
    });
    await localApp.ready();
    try {
      const res = await localApp.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 600,
          message: {
            message_id: 600,
            from: {
              id: 100,
              is_bot: false,
              username: "customer_100",
              first_name: "Nguyen",
              last_name: "An",
              language_code: "vi",
            },
            chat: { id: 100, type: "private", first_name: "Nguyen", last_name: "An" },
            contact: {
              phone_number: "+84912345678",
              user_id: 100,
              first_name: "Nguyen",
              last_name: "An",
            },
            text: "/admin@tier20ai_bot",
            entities: [{ type: "bot_command", offset: 0, length: 19 }],
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toMatchObject({
        command: "/admin",
        action: "ADMIN",
        actorUsername: "customer_100",
        firstName: "Nguyen",
        lastName: "An",
        languageCode: "vi",
        contactPhoneNumber: "+84912345678",
      });
    } finally {
      await localApp.close();
    }
  });

  it("preserves plain wallet amount text in the durable envelope", async () => {
    let seen: unknown = null;
    const localApp = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(localApp, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          seen = input.envelope;
          return { kind: "ACCEPTED", id: "wallet-amount" };
        },
      },
    });
    await localApp.ready();
    try {
      const res = await localApp.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(601, 100, "375000"),
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toMatchObject({
        action: "UNKNOWN",
        messageText: "375000",
      });
    } finally {
      await localApp.close();
    }
  });
});
