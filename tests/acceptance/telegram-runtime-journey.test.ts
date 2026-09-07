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

  it("creates a fresh identity and customer profile snapshot from signed /start", async () => {
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
            from: {
              id: Number(userId),
              username: "fresh_customer",
              first_name: "Fresh",
              last_name: "Customer",
              language_code: "vi",
            },
            chat: { id: Number(userId), type: "private" },
            text: "/start",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ queued: true });

      const { upsertTelegramCustomerProfileSnapshot } =
        await import("../../src/modules/identity/customer-profile.js");
      const processed = await processTelegramInboxBatch({
        inbox,
        limiter: { tryConsume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) },
        handler: async (envelope) => {
          const observedUsername = await consumeTelegramUsernameObservation(
            ctx.db,
            envelope.actorUserId,
          );
          const resolved = await ensureTelegramIdentity(ctx.db, {
            telegramUserId: envelope.actorUserId,
            ...(observedUsername ? { observedUsername } : {}),
          });
          await upsertTelegramCustomerProfileSnapshot(ctx.db, {
            customerId: resolved.customerId,
            telegramUserId: envelope.actorUserId,
            chatId: envelope.chatId,
            username: envelope.actorUsername ?? observedUsername ?? null,
            firstName: envelope.firstName ?? null,
            lastName: envelope.lastName ?? null,
            languageCode: envelope.languageCode ?? null,
            phoneNumber: envelope.contactPhoneNumber ?? null,
            reachable: true,
          });
          await dispatcher.handle(envelope);
        },
        owner: "acceptance-worker",
        batchSize: 10,
      });
      expect(processed).toMatchObject({ claimed: 1, processed: 1 });
      expect(send).toHaveBeenCalledTimes(1);

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
      const profile = await sql<{
        customer_id: string;
        telegram_user_id: string;
        chat_id: string;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
        display_name: string | null;
        language_code: string | null;
        reachable: boolean;
        phone_number: string | null;
      }>`
        select customer_id, telegram_user_id, chat_id, username, first_name, last_name, display_name, language_code, reachable, phone_number
        from customer_profile_snapshot
        where customer_id = ${identity.rows[0]?.customer_id}
      `.execute(ctx.db);
      expect(profile.rows).toEqual([
        {
          customer_id: identity.rows[0]?.customer_id,
          telegram_user_id: userId,
          chat_id: userId,
          username: "fresh_customer",
          first_name: "Fresh",
          last_name: "Customer",
          display_name: "Fresh Customer",
          language_code: "vi",
          reachable: true,
          phone_number: null,
        },
      ]);
    } finally {
      await app.close();
    }
  });
});
