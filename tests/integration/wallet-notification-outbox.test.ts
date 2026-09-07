import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { newId } from "../../src/shared/ids/index.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import {
  claimNotificationDeliveries,
  processNotificationDeliveryClaim,
} from "../../src/modules/notification/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table notification_delivery, notification_campaign, notification_preference,
      channel_identity, customer_profile_snapshot, outbox_event, customer cascade
  `.execute(ctx.db);
});

describe("wallet notification outbox", () => {
  async function seedCustomer(chatId: string): Promise<string> {
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
      ctx.db,
    );
    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id)
      values (${newId()}, ${customerId}, 'TELEGRAM', ${chatId})
    `.execute(ctx.db);
    return customerId;
  }

  function walletHandler() {
    return createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: createInMemoryVault(),
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });
  }

  it("drains wallet events into idempotent critical customer notifications", async () => {
    const customerId = await seedCustomer("123456789");
    const topupId = newId();
    const refundOrderId = newId();
    const events = [
      ["WalletTopupPresented", topupId, 1, { intentId: topupId, customerId, amountVnd: 150000 }],
      ["WalletTopupCredited", topupId, 2, { intentId: topupId, customerId, amountVnd: 150000 }],
      [
        "WalletRefunded",
        refundOrderId,
        3,
        { orderId: refundOrderId, customerId, amountVnd: "75000" },
      ],
    ] as const;
    for (const [eventType, aggregateId, aggregateVersion, payloadRedacted] of events) {
      await enqueueOutboxEvent(ctx.db, {
        id: newId(),
        aggregateType: eventType === "WalletRefunded" ? "Order" : "WalletTopupIntent",
        aggregateId,
        aggregateVersion,
        eventType,
        payloadRedacted,
      });
    }

    const handler = walletHandler();
    const first = await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });
    await sql`update outbox_event set published_at = null, next_attempt_at = null where event_type in ('WalletTopupPresented','WalletTopupCredited','WalletRefunded')`.execute(
      ctx.db,
    );
    const replay = await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });

    const deliveries = await sql<{
      campaign_id: string;
      customer_id: string;
      chat_id: string;
      class: string;
      content: string;
    }>`
      select d.campaign_id, d.customer_id, d.chat_id, c.class, c.content
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
      order by d.campaign_id
    `.execute(ctx.db);

    expect(first.published).toBe(3);
    expect(replay.published).toBe(3);
    expect(deliveries.rows).toEqual([
      {
        campaign_id: `wallet-refunded:${refundOrderId}`,
        customer_id: customerId,
        chat_id: "123456789",
        class: "CRITICAL_SERVICE",
        content: "Ví của bạn đã được hoàn 75000đ.",
      },
      {
        campaign_id: `wallet-topup-credited:${topupId}`,
        customer_id: customerId,
        chat_id: "123456789",
        class: "CRITICAL_SERVICE",
        content: "Ví của bạn đã được cộng 150000đ.",
      },
      {
        campaign_id: `wallet-topup-presented:${topupId}`,
        customer_id: customerId,
        chat_id: "123456789",
        class: "CRITICAL_SERVICE",
        content: "Yêu cầu nạp ví 150000đ đang chờ thanh toán.",
      },
    ]);

    const claims = await claimNotificationDeliveries(ctx.db, 10);
    const sent: string[] = [];
    for (const claim of claims) {
      expect(
        await processNotificationDeliveryClaim(ctx.db, claim, {
          send: async (input) => {
            sent.push(input.chatId);
          },
        }),
      ).toBe("SENT");
    }
    expect(sent).toEqual(["123456789", "123456789", "123456789"]);
  });

  it.each(
    ["WalletTopupPresented", "WalletTopupCredited", "WalletRefunded"].flatMap((eventType) => [
      { eventType, payload: { amountVnd: 100000 } },
      { eventType, payload: { customerId: "customer", amountVnd: 0 } },
      { eventType, payload: { customerId: "customer", amountVnd: "0" } },
    ]),
  )(
    "dead-letters malformed $eventType payloads instead of publishing",
    async ({ eventType, payload }) => {
      await enqueueOutboxEvent(ctx.db, {
        id: newId(),
        aggregateType: eventType === "WalletRefunded" ? "Order" : "WalletTopupIntent",
        aggregateId: newId(),
        aggregateVersion: 1,
        eventType,
        payloadRedacted: payload,
      });

      const drain = await drainOutboxOnce(ctx.db, {
        batchSize: 1,
        maxAttempts: 5,
        handler: walletHandler(),
      });
      const outbox = await sql<{
        published_at: Date | null;
        dead_lettered_at: Date | null;
        last_error_code: string | null;
      }>`
        select published_at, dead_lettered_at, last_error_code from outbox_event
      `.execute(ctx.db);

      expect(drain).toMatchObject({ published: 0, failed: 1, terminal: 1 });
      expect(outbox.rows[0]?.published_at).toBeNull();
      expect(outbox.rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
      expect(outbox.rows[0]?.last_error_code).toBe("WALLET_NOTIFICATION_PAYLOAD_INVALID");
    },
  );
  it("retries critical wallet notifications when no customer target exists", async () => {
    await sql`insert into customer (id, status, locale) values ('customer-no-chat', 'ACTIVE', 'vi-VN')`.execute(
      ctx.db,
    );
    await enqueueOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "WalletTopupIntent",
      aggregateId: "topup-no-chat",
      aggregateVersion: 1,
      eventType: "WalletTopupCredited",
      payloadRedacted: {
        intentId: "topup-no-chat",
        customerId: "customer-no-chat",
        amountVnd: 100000,
      },
    });

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 1,
      maxAttempts: 5,
      handler: walletHandler(),
    });
    const outbox = await sql<{ published_at: Date | null; last_error_code: string | null }>`
      select published_at, last_error_code from outbox_event
    `.execute(ctx.db);

    expect(drain).toMatchObject({ published: 0, failed: 1 });
    expect(outbox.rows[0]).toMatchObject({
      published_at: null,
      last_error_code: "CRITICAL_NOTIFICATION_TARGET_MISSING",
    });
  });
});
