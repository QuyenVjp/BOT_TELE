import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createTelegramDomainDispatcher } from "../../src/bot/callbacks/telegram-dispatch.js";
import {
  consumeTelegramUsernameObservation,
  createPostgresTelegramInbox,
  processTelegramInboxBatch,
} from "../../src/infrastructure/inbox/telegram.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import {
  TELEGRAM_CHANNEL,
  ensureTelegramIdentity,
  resolveTelegramCustomerId,
} from "../../src/modules/identity/channel-identity.js";
import { sql } from "kysely";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
const WEBHOOK_FIXTURE = ["telegram", "webhook", "fixture", "value", "123456"].join("-");

describe.skipIf(!hasDocker)("Telegram HTTP -> durable inbox -> domain command (T129)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it("creates a fresh identity from signed /start before dispatching the catalog domain", async () => {
    const userId = "123456789";
    const inbox = createPostgresTelegramInbox(ctx.db);
    const codec = createCallbackTokenCodec({
      key: "test-only-runtime-callback-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const mainMenu = vi.fn().mockResolvedValue({
      text: "domain-menu",
      buttons: [[{ text: "browse", callbackData: "cat:list" }]],
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTelegramDomainDispatcher({
      codec,
      resolveCustomerId: (telegramUserId) => resolveTelegramCustomerId(ctx.db, telegramUserId),
      resolveOrderById: vi.fn().mockResolvedValue(null),
      resolveOrderIdByNumber: vi.fn().mockResolvedValue(null),
      resolveCatalogPage: vi.fn().mockResolvedValue(null),
      catalog: {
        mainMenu,
        categoryList: vi.fn(),
        categoryView: vi.fn(),
        variantDetail: vi.fn(),
        search: vi.fn(),
      },
      checkout: {
        buyNowFromCallback: vi.fn(),
        refresh: vi.fn(),
        reopen: vi.fn(),
        cancel: vi.fn(),
      },
      history: { list: vi.fn(), detail: vi.fn() },
      support: { reasonMenu: vi.fn(), open: vi.fn(), list: vi.fn() },
      responder: { send },
    });
    const app = await createApp({
      db: ctx.db,
      vault: {
        write: vi.fn(),
        reveal: vi.fn(),
        delete: vi.fn(),
      } as unknown as Vault,
      telegram: {
        path: "/telegram/webhook",
        secretToken: WEBHOOK_FIXTURE,
        inbox,
      },
      sepay: {
        path: "/webhooks/sepay",
        handler: vi.fn().mockResolvedValue({ status: 503, body: { success: false } }),
      },
      bodyLimitBytes: 65_536,
      logger: false,
    });

    try {
      const rejected = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong-webhook-secret",
        },
        payload: {
          update_id: 9000,
          message: {
            message_id: 76,
            from: { id: Number(userId), username: "must_not_persist" },
            chat: { id: Number(userId), type: "private" },
            text: "/start",
          },
        },
      });
      expect(rejected.statusCode).toBe(401);
      const rejectedWrites = await sql<{ inbox_count: string; observation_count: string }>`
        select
          (select count(*)::text from webhook_inbox where source = 'telegram') as inbox_count,
          (select count(*)::text from telegram_username_observation) as observation_count
      `.execute(ctx.db);
      expect(rejectedWrites.rows).toEqual([{ inbox_count: "0", observation_count: "0" }]);

      const response = await app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": WEBHOOK_FIXTURE,
        },
        payload: {
          update_id: 9001,
          message: {
            message_id: 77,
            from: { id: Number(userId), username: "fresh_customer" },
            chat: { id: Number(userId), type: "private" },
            text: "/start",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ queued: true });

      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: { tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) },
        handler: async (envelope) => {
          const observedUsername = await consumeTelegramUsernameObservation(
            ctx.db,
            envelope.actorUserId,
          );
          await ensureTelegramIdentity(ctx.db, {
            telegramUserId: envelope.actorUserId,
            ...(observedUsername ? { observedUsername } : {}),
          });
          await dispatcher.handle(envelope);
        },
        owner: "acceptance-worker",
        batchSize: 10,
      });
      expect(processed).toMatchObject({ claimed: 1, processed: 1 });
      expect(mainMenu).toHaveBeenCalledTimes(1);
      const identity = await sql<{
        customer_id: string;
        channel: string;
        observed_username: string | null;
      }>`
        select customer_id, channel, observed_username
        from channel_identity
        where channel_user_id = ${userId}
      `.execute(ctx.db);
      expect(identity.rows).toEqual([
        {
          customer_id: expect.any(String),
          channel: TELEGRAM_CHANNEL,
          observed_username: "fresh_customer",
        },
      ]);
      expect(await resolveTelegramCustomerId(ctx.db, userId)).toBe(identity.rows[0]?.customer_id);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: userId,
          message: expect.objectContaining({ text: "domain-menu" }),
        }),
      );
    } finally {
      await app.close();
    }
  });
});
