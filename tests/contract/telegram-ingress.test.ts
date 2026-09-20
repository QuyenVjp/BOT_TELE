import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  verifyTelegramSecret,
  normalizeInboundText,
  MAX_TEXT_LENGTH,
} from "../../src/bot/middleware/security.js";
import { registerTelegramWebhook, createInMemoryUpdateInbox } from "../../src/bot/webhook.js";
import type { TelegramCommandEnvelope } from "../../src/infrastructure/inbox/telegram.js";

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

describe("owner remediation prompt text ingress", () => {
  it("admits owner text only while a remediation prompt is active", async () => {
    const accepted: unknown[] = [];
    let active = true;
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
      ownerPromptText: {
        adminTelegramUserId: 123456789,
        isActive: async () => active,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(
          8991,
          123456789,
          "OWNER_ATTESTATION|REF-1|pre-production authorization",
        ),
      });
      active = false;
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(8992, 123456789, "OWNER_ATTESTATION|REF-2|must not pass"),
      });

      expect(accepted).toHaveLength(2);
      expect(accepted[0]).toMatchObject({
        messageText: "OWNER_ATTESTATION|REF-1|pre-production authorization",
        ownerPromptText: true,
      });
      expect(accepted[1]).not.toHaveProperty("messageText");
    } finally {
      await ingress.close();
    }
  });
  it("prioritizes an active product draft over an overlapping owner remediation prompt", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
      ownerPromptText: {
        adminTelegramUserId: 123456789,
        isActive: async () => true,
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async () => "name",
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(8993, 123456789, "New product"),
      });
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        messageText: "New product",
        rootProductDraftText: true,
      });
      expect(accepted[0]?.ownerPromptText).toBeUndefined();
    } finally {
      await ingress.close();
    }
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
        activeStep: async (telegramUserId) => (telegramUserId === "123456789" ? "name" : null),
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

  it("preserves 8-step description and variant text for the root admin", async () => {
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
          telegramUserId === "123456789"
            ? accepted.length === 0
              ? "description"
              : "variant"
            : null,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9010, 123456789, "Tài khoản GPT Plus dùng 1 tháng"),
      });
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9011, 123456789, "1 tháng | 250000"),
      });

      expect(accepted).toHaveLength(2);
      expect(accepted[0]).toMatchObject({
        messageText: "Tài khoản GPT Plus dùng 1 tháng",
        rootProductDraftText: true,
      });
      expect(accepted[1]).toMatchObject({
        messageText: "1 tháng | 250000",
        rootProductDraftText: true,
      });
    } finally {
      await ingress.close();
    }
  });

  it("preserves deliveryConfig supplier text only at that step", async () => {
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
          telegramUserId === "123456789" ? "deliveryConfig" : null,
      },
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9012, 123456789, "sup-1 | EXT-SKU | 120000 | VN"),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        messageText: "sup-1 | EXT-SKU | 120000 | VN",
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

describe("admin inventory import text ingress", () => {
  it("accepts safe multi-line CSV/pipe inventory paste when import session is active", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
      inventoryImportText: {
        adminTelegramUserId: 123456789,
        isActive: async (id) => id === "123456789",
      },
    });
    await ingress.ready();
    try {
      const payload = "email1|user1|pass1\nemail2|user2|pass2";
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9010, 123456789, payload),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.action).toBe("ADMIN");
      expect(accepted[0]?.inventoryImportText).toBe(true);
      expect(accepted[0]?.messageText).toBe(payload);
    } finally {
      await ingress.close();
    }
  });

  it("rejects inventory paste when session is not active", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
      inventoryImportText: {
        adminTelegramUserId: 123456789,
        isActive: async () => false,
      },
    });
    await ingress.ready();
    try {
      const payload = "email1|user1|pass1\nemail2|user2|pass2";
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9011, 123456789, payload),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]).not.toHaveProperty("messageText");
      expect(accepted[0]?.inventoryImportText).toBeUndefined();
    } finally {
      await ingress.close();
    }
  });

  it("prefers an active inventory session over leftover product-draft description text", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
    let draftStepCalls = 0;
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
      inventoryImportText: {
        adminTelegramUserId: 123456789,
        isActive: async (id) => id === "123456789",
      },
      rootProductDraftText: {
        adminTelegramUserId: 123456789,
        activeStep: async () => {
          draftStepCalls += 1;
          return "description";
        },
      },
    });
    await ingress.ready();
    try {
      const payload =
        "final.account.001@example.invalid|user1|pass1\nfinal.account.002@example.invalid|user2|pass2";
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9012, 123456789, payload),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.action).toBe("ADMIN");
      expect(accepted[0]?.inventoryImportText).toBe(true);
      expect(accepted[0]?.rootProductDraftText).toBeUndefined();
      expect(accepted[0]?.messageText).toBe(payload);
      expect(draftStepCalls).toBe(0);
    } finally {
      await ingress.close();
    }
  });

  it("strips Telegram Web format controls from inventory paste and still accepts it", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
      inventoryImportText: {
        adminTelegramUserId: 123456789,
        isActive: async (id) => id === "123456789",
      },
    });
    await ingress.ready();
    try {
      const payload = "email1\u200b|user1|pass1\nemail2|user2|pass2";
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(9013, 123456789, payload),
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.inventoryImportText).toBe(true);
      expect(accepted[0]?.messageText).toBe("email1|user1|pass1\nemail2|user2|pass2");
    } finally {
      await ingress.close();
    }
  });
});

describe("group commerce and inline query ingress", () => {
  it("accepts inline_query and normalizes to CATALOG action with query and offset", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9101,
          inline_query: {
            id: "iq-101",
            from: { id: 12345, username: "tester", first_name: "Test" },
            query: "claude",
            offset: "0",
            chat_type: "supergroup",
          },
        },
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.action).toBe("CATALOG");
      expect(accepted[0]?.inlineQuery).toEqual({
        id: "iq-101",
        query: "claude",
        offset: "0",
        chatType: "supergroup",
      });
    } finally {
      await ingress.close();
    }
  });

  it("accepts chosen_inline_result and captures resultId and query", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9102,
          chosen_inline_result: {
            result_id: "prod-claude-pro",
            from: { id: 12345, username: "tester", first_name: "Test" },
            query: "claude",
            inline_message_id: "imi-999",
          },
        },
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.action).toBe("CATALOG");
      expect(accepted[0]?.chosenInlineResult).toEqual({
        resultId: "prod-claude-pro",
        query: "claude",
        inlineMessageId: "imi-999",
      });
    } finally {
      await ingress.close();
    }
  });

  it("accepts group command with supergroup chatType and negative chatId", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9103,
          message: {
            message_id: 100,
            from: { id: 12345, is_bot: false },
            chat: { id: -1003906082671, type: "supergroup", title: "AI Codex" },
            text: "/shop@tier20ai_bot",
          },
        },
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.command).toBe("/shop");
      expect(accepted[0]?.chatType).toBe("supergroup");
      expect(accepted[0]?.chatId).toBe("-1003906082671");
      expect(accepted[0]?.action).toBe("CATALOG");
    } finally {
      await ingress.close();
    }
  });

  it("drops unmentioned group conversation when MENTION_ONLY is active", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9104,
          message: {
            message_id: 101,
            from: { id: 12345, is_bot: false },
            chat: { id: -1003906082671, type: "supergroup", title: "AI Codex" },
            text: "Claude ngon không mọi người?",
          },
        },
      });

      expect(accepted).toHaveLength(0);
    } finally {
      await ingress.close();
    }
  });

  it("accepts group question when bot is mentioned and passes clean prose", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9105,
          message: {
            message_id: 102,
            from: { id: 12345, is_bot: false },
            chat: { id: -1003906082671, type: "supergroup", title: "AI Codex" },
            text: "@tier20ai_bot Claude Pro còn hàng không?",
          },
        },
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.messageText).toBe("Claude Pro còn hàng không?");
      expect(accepted[0]?.chatType).toBe("supergroup");
      expect(accepted[0]?.action).toBe("CATALOG");
    } finally {
      await ingress.close();
    }
  });

  it("accepts new_chat_members event in group and captures members", async () => {
    const accepted: TelegramCommandEnvelope[] = [];
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
    });
    await ingress.ready();
    try {
      await ingress.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: {
          update_id: 9106,
          message: {
            message_id: 103,
            from: { id: 12345, is_bot: false },
            chat: { id: -1003906082671, type: "supergroup", title: "AI Codex" },
            new_chat_members: [
              { id: 99991, is_bot: false, first_name: "Nguyen" },
              { id: 99992, is_bot: true, first_name: "SpamBot" },
            ],
          },
        },
      });

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.chatType).toBe("supergroup");
      expect(accepted[0]?.newChatMembers).toHaveLength(1);
      expect(accepted[0]?.newChatMembers?.[0]?.firstName).toBe("Nguyen");
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

  it("preserves /confirm arguments through webhook normalization", async () => {
    let seen: TelegramCommandEnvelope | undefined;
    const localApp = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(localApp, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          seen = input.envelope;
          return { kind: "ACCEPTED", id: "confirm-ingress" };
        },
      },
    });
    await localApp.ready();
    try {
      const res = await localApp.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(602, 100, "/confirm confirmation-id challenge"),
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toMatchObject({
        command: "/confirm",
        action: "ADMIN",
        searchQuery: "confirmation-id challenge",
      });
    } finally {
      await localApp.close();
    }
  });

  it("preserves /verify arguments as an admin command", async () => {
    let seen: TelegramCommandEnvelope | undefined;
    const localApp = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(localApp, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          seen = input.envelope;
          return { kind: "ACCEPTED", id: "verify-ingress" };
        },
      },
    });
    await localApp.ready();
    try {
      const res = await localApp.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        payload: buildUpdate(603, 100, "/verify 123456 telegram:603"),
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toMatchObject({
        command: "/verify",
        action: "ADMIN",
        searchQuery: "123456 telegram:603",
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

describe("persistent reply-keyboard allowlist", () => {
  it("preserves current Telegram-native keyboard labels and drops retired wallet and Mini App labels", async () => {
    const kept: Array<string | undefined> = [];
    const ingress = Fastify({ bodyLimit: BODY_LIMIT });
    await registerTelegramWebhook(ingress, {
      path: WEBHOOK_PATH,
      secretToken: SECRET,
      inbox: {
        async accept(input) {
          kept.push(input.envelope.messageText);
          return { kind: "ACCEPTED", id: `accepted:${input.sourceEventId}` };
        },
      },
    });
    await ingress.ready();
    try {
      const labels = [
        "🛒 Mua hàng",
        "🛡 Bảo hành",
        "💬 Hỗ trợ",
        "👤 Tài khoản",
        "🧾 Đơn hàng",
        "💰 Nạp ví",
        "🌐 Mở cửa hàng",
      ];
      for (const [i, label] of labels.entries()) {
        await ingress.inject({
          method: "POST",
          url: WEBHOOK_PATH,
          headers: { "x-telegram-bot-api-secret-token": SECRET },
          payload: buildUpdate(8000 + i, 100, label),
        });
      }
      expect(kept).toEqual([
        "🛒 Mua hàng",
        "🛡 Bảo hành",
        "💬 Hỗ trợ",
        "👤 Tài khoản",
        "🧾 Đơn hàng",
        undefined,
        undefined,
      ]);
    } finally {
      await ingress.close();
    }
  });
});
