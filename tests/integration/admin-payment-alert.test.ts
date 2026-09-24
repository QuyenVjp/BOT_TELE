import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  handleNotificationOutboxEvent,
  claimNotificationDeliveries,
  processNotificationDeliveryClaim,
} from "../../src/modules/notification/service.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
const ROOT_TELEGRAM_ID = 99887766;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table notification_delivery, notification_campaign, notification_preference,
      channel_identity, customer_profile_snapshot, payment_allocation, payment_intent,
      bank_transaction, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedFixture(): Promise<{ orderId: string; rootCustomerId: string }> {
  const rootCustomerId = newId();
  const buyerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const intentId = newId();
  const transactionId = newId();
  const allocationId = newId();
  await sql`insert into customer (id, status, locale)
    values (${rootCustomerId}, 'ACTIVE', 'vi'), (${buyerId}, 'ACTIVE', 'vi')`.execute(ctx.db);
  await sql`insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${rootCustomerId}, 'TELEGRAM', ${String(ROOT_TELEGRAM_ID)})`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug)
    values (${categoryId}, 'AI', ${`ai-${categoryId.slice(-8)}`})`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, is_test, is_archived)
    values (${productId}, ${categoryId}, 'ChatGPT Plus', ${`chatgpt-${productId.slice(-8)}`}, true, false, false)`.execute(
    ctx.db,
  );
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code,
      delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, '1 tháng', 250000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')`.execute(ctx.db);
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi,
      variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, status, paid_at, version)
    values (${orderId}, 'ORD-ALERT-1', ${buyerId}, ${variantId}, 'ChatGPT Plus', '1 tháng',
      250000, 'P1M', 'CREDENTIAL', 0, 'PAID', now(), 1)`.execute(ctx.db);
  await sql`insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id,
      transfer_content, expires_at, settled_at)
    values (${intentId}, ${orderId}, 'SUCCEEDED', 250000, 'SEPAY-ACCOUNT', 'TIER20-ALERT',
      now() + interval '1 day', now())`.execute(ctx.db);
  await sql`insert into bank_transaction (id, provider, provider_transaction_id, direction,
      merchant_account_id, amount_vnd, content, reference, transacted_at, raw_hash, signature_status,
      schema_version)
    values (${transactionId}, 'sepay', 'provider-alert-1', 'IN', 'SEPAY-ACCOUNT', 250000,
      'safe-content', 'safe-reference', now(), ${"a".repeat(64)}, 'VERIFIED', 'v1')`.execute(
    ctx.db,
  );
  await sql`insert into payment_allocation (id, bank_transaction_id, payment_intent_id,
      allocated_amount_vnd, status, decision_code, correlation_id)
    values (${allocationId}, ${transactionId}, ${intentId}, 250000, 'SETTLED', 'EXACT_MATCH',
      'alert-test')`.execute(ctx.db);
  return { orderId, rootCustomerId };
}

function event(eventType: string, orderId: string) {
  return {
    id: newId(),
    aggregateType: "PaymentIntent",
    aggregateId: newId(),
    aggregateVersion: 1,
    eventType,
    payloadRedacted: { orderId, correlationId: "alert-test" },
    attemptCount: 0,
    claimedBy: "test",
    generation: 1,
  } as const;
}

describe("admin payment alert", () => {
  it("does not alert on an unverified or unmatched settlement payload", async () => {
    const { orderId } = await seedFixture();
    await sql`update bank_transaction set signature_status = 'UNVERIFIED'`.execute(ctx.db);
    const result = await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
    });
    expect(result).toMatchObject({ kind: "PUBLISHED" });
    const campaigns =
      await sql`select id from notification_campaign where id like 'admin-payment-%'`.execute(
        ctx.db,
      );
    expect(campaigns.rows).toHaveLength(0);
  });

  it("suppresses admin alerts without changing settlement handling when mode is OFF", async () => {
    const { orderId } = await seedFixture();
    const result = await handleNotificationOutboxEvent(ctx.db, event("PaymentSettled", orderId), {
      rootTelegramUserId: ROOT_TELEGRAM_ID,
      adminAlertMode: "OFF",
    });
    expect(result).toMatchObject({ kind: "PUBLISHED" });
    const campaigns =
      await sql`select id from notification_campaign where id like 'admin-payment-%'`.execute(
        ctx.db,
      );
    expect(campaigns.rows).toHaveLength(0);
  });

  it("deduplicates settlement, persists message identity, and edits on completion", async () => {
    const { orderId } = await seedFixture();
    const settled = event("PaymentSettled", orderId);
    expect(
      await handleNotificationOutboxEvent(ctx.db, settled, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    expect(
      await handleNotificationOutboxEvent(ctx.db, settled, {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const count = await sql<{
      count: string;
    }>`select count(*)::text as count from notification_delivery`.execute(ctx.db);
    expect(count.rows[0]?.count).toBe("1");

    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async (input) => {
        expect(input.messageId).toBeNull();
        return { chatId: input.chatId, messageId: "telegram-101" };
      },
    });
    const sent = await sql<{
      message_id: string;
    }>`select message_id from notification_delivery`.execute(ctx.db);
    expect(sent.rows[0]?.message_id).toBe("telegram-101");

    await sql`update "order" set status = 'COMPLETED', completed_at = now(), version = 2 where id = ${orderId}`.execute(
      ctx.db,
    );
    expect(
      await handleNotificationOutboxEvent(ctx.db, event("FulfillmentCompleted", orderId), {
        rootTelegramUserId: ROOT_TELEGRAM_ID,
      }),
    ).toMatchObject({ kind: "PUBLISHED" });
    const [updateClaim] = await claimNotificationDeliveries(ctx.db, 1);
    let editedMessageId: string | null = null;
    await processNotificationDeliveryClaim(ctx.db, updateClaim!, {
      send: async (input) => {
        editedMessageId = input.messageId;
        return { chatId: input.chatId, messageId: "telegram-101" };
      },
    });
    expect(editedMessageId).toBe("telegram-101");
    const campaign = await sql<{
      content: string;
    }>`select content from notification_campaign where id = ${`admin-payment-settled:${orderId}`}`.execute(
      ctx.db,
    );
    expect(campaign.rows[0]?.content).toContain("Đã hoàn tất");
  });
});
