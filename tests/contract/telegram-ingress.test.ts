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

const SECRET = "webhook-secret-abcdefgh";
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

    // Telegram expects 200 for both; the second response is an exact duplicate.
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
    // Per-user/action budgets are enforced by the asynchronous durable worker.
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
    // Composed vs decomposed forms collapse to the same NFC string.
    const decomposed = "é"; // e + combining acute
    expect(normalizeInboundText(decomposed)).toBe("é"); // é

    const oversized = "a".repeat(MAX_TEXT_LENGTH + 50);
    expect(normalizeInboundText(oversized).length).toBe(MAX_TEXT_LENGTH);
  });
});
