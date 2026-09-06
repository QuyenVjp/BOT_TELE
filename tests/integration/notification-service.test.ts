import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { newId } from "../../src/shared/ids/index.js";
import {
  claimNotificationDeliveries,
  cancelBroadcast,
  createBroadcast,
  enqueueBroadcastRecipients,
  getBroadcastStatus,
  getNotificationPreferences,
  handleNotificationOutboxEvent,
  markNotificationFailure,
  markNotificationSent,
  processNotificationDeliveryClaim,
  setNotificationPreferences,
  markBroadcastPreviewed,
  previewBroadcastAudience,
} from "../../src/modules/notification/service.js";
import { subscribeRestock } from "../../src/modules/catalog/restock.js";
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
      restock_subscription, channel_identity, customer_profile_snapshot, digital_asset,
      outbox_event, product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedCustomer(chatId: string): Promise<string> {
  const customerId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', ${chatId})
  `.execute(ctx.db);
  return customerId;
}

async function seedVariant(): Promise<string> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Cat', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Product', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code,
      delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Variant', 100000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  return variantId;
}

describe("notification service", () => {
  it("defaults missing customer notification preference to opt-out", async () => {
    const customerId = await seedCustomer("111111");

    const pref = await getNotificationPreferences(ctx.db, customerId);

    expect(pref.shopUpdates).toBe(false);
    expect(pref.purchaseActivity).toBe(false);
  });
  it("preserves omitted quiet hours and clears explicitly null hours", async () => {
    const customerId = await seedCustomer("111111");
    await setNotificationPreferences(ctx.db, { customerId, quietStart: "22:00", quietEnd: "07:00" });
    expect(await setNotificationPreferences(ctx.db, { customerId, shopUpdates: true })).toMatchObject({ quietStart: "22:00:00", quietEnd: "07:00:00", shopUpdates: true });
    expect(await setNotificationPreferences(ctx.db, { customerId, quietStart: null, quietEnd: null })).toMatchObject({ quietStart: null, quietEnd: null, shopUpdates: true });
  });

  it("claims delivery rows once under concurrent claimers", async () => {
    const customerA = await seedCustomer("111111");
    const customerB = await seedCustomer("222222");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "claim-once",
    });
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id)
      values (${newId()}, ${campaignId}, ${customerA}, '111111'),
             (${newId()}, ${campaignId}, ${customerB}, '222222')
    `.execute(ctx.db);

    const [a, b] = await Promise.all([
      claimNotificationDeliveries(ctx.db, 2),
      claimNotificationDeliveries(ctx.db, 2),
    ]);

    const ids = [...a, ...b].map((row) => row.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("fans out a previewed draft once and ignores repeated confirmation", async () => {
    const first = await seedCustomer("111111");
    const second = await seedCustomer("222222");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${first}, true, false)
    `.execute(ctx.db);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Sale",
      createdBy: "admin",
      idempotencyKey: "fanout",
    });

    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(0);
    expect(await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "wrong-admin", content: "Sale" })).toBe(false);
    expect(await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Sale" })).toBe(true);
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(1);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${second}, true, false)
    `.execute(ctx.db);
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(0);
    const rows = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery order by customer_id
    `.execute(ctx.db);
    const status = await getBroadcastStatus(ctx.db, campaignId);

    expect(rows.rows).toEqual([{ customer_id: first }]);
    expect(rows.rows).not.toContainEqual({ customer_id: second });
    expect(status).toMatchObject({ status: "QUEUED", total: 1, pending: 1 });
  });

  it("coalesces root preview and delivery to stored reachable chat", async () => {
    const rootCustomer = await seedCustomer("111111");
    await sql`
      insert into customer_profile_snapshot(customer_id, telegram_user_id, chat_id, reachable)
      values (${rootCustomer}, '111111', '999999', true)
    `.execute(ctx.db);
    await seedCustomer("222222");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "Owner preview",
      createdBy: "admin",
      idempotencyKey: "root-fanout",
      audience: "root",
    });

    expect(await previewBroadcastAudience(ctx.db, "root", "111111")).toBe(1);
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId, "111111")).toBe(0);
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Owner preview" });
    const count = await enqueueBroadcastRecipients(ctx.db, campaignId, "111111");
    const deliveries = await sql<{ customer_id: string; chat_id: string }>`
      select customer_id, chat_id from notification_delivery order by customer_id
    `.execute(ctx.db);

    expect(count).toBe(1);
    expect(deliveries.rows).toEqual([{ customer_id: rootCustomer, chat_id: "999999" }]);
  });

  it("omits unreachable root from preview and delivery", async () => {
    const rootCustomer = await seedCustomer("111111");
    await sql`
      insert into customer_profile_snapshot(customer_id, telegram_user_id, chat_id, reachable)
      values (${rootCustomer}, '111111', '999999', false)
    `.execute(ctx.db);
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "Owner preview",
      createdBy: "admin",
      idempotencyKey: "root-unreachable",
      audience: "root",
    });

    expect(await previewBroadcastAudience(ctx.db, "root", "111111")).toBe(0);
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Owner preview" });
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId, "111111")).toBe(0);
  });

  it("cancels pending and retry deliveries without reviving the broadcast later", async () => {
    const sentCustomer = await seedCustomer("111111");
    const retryCustomer = await seedCustomer("222222");
    const pendingCustomer = await seedCustomer("333333");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "Service notice",
      createdBy: "admin",
      idempotencyKey: "cancel-status",
    });
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Service notice" });
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id, status)
      values (${newId()}, ${campaignId}, ${sentCustomer}, '111111', 'SENT'),
             (${newId()}, ${campaignId}, ${retryCustomer}, '222222', 'RETRY'),
             (${newId()}, ${campaignId}, ${pendingCustomer}, '333333', 'PENDING')
    `.execute(ctx.db);

    expect(await cancelBroadcast(ctx.db, campaignId)).toBe(2);
    const deliveriesAfterCancel = await sql<{ customer_id: string; status: string; last_error: string | null }>`
      select customer_id, status, last_error from notification_delivery order by customer_id
    `.execute(ctx.db);
    await seedCustomer("444444");
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(0);
    const status = await getBroadcastStatus(ctx.db, campaignId);

    expect(deliveriesAfterCancel.rows).toEqual([
      { customer_id: pendingCustomer, status: "SUPPRESSED", last_error: "admin_cancelled" },
      { customer_id: retryCustomer, status: "SUPPRESSED", last_error: "admin_cancelled" },
      { customer_id: sentCustomer, status: "SENT", last_error: null },
    ].sort((a, b) => a.customer_id.localeCompare(b.customer_id)));
    expect(status).toMatchObject({
      campaignId,
      status: "CANCELLED",
      total: 3,
      pending: 0,
      retry: 0,
      sent: 1,
      suppressed: 2,
      dead: 0,
    });
  });

  it("returns actual broadcast status counts and null for an unknown broadcast", async () => {
    const sentCustomer = await seedCustomer("111111");
    const retryCustomer = await seedCustomer("222222");
    const pendingCustomer = await seedCustomer("333333");
    const suppressedCustomer = await seedCustomer("444444");
    const deadCustomer = await seedCustomer("555555");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "Status notice",
      createdBy: "admin",
      idempotencyKey: "status-counts",
    });
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id, status)
      values (${newId()}, ${campaignId}, ${sentCustomer}, '111111', 'SENT'),
             (${newId()}, ${campaignId}, ${retryCustomer}, '222222', 'RETRY'),
             (${newId()}, ${campaignId}, ${pendingCustomer}, '333333', 'PENDING'),
             (${newId()}, ${campaignId}, ${suppressedCustomer}, '444444', 'SUPPRESSED'),
             (${newId()}, ${campaignId}, ${deadCustomer}, '555555', 'DEAD')
    `.execute(ctx.db);

    await expect(getBroadcastStatus(ctx.db, newId())).resolves.toBeNull();
    await expect(getBroadcastStatus(ctx.db, campaignId)).resolves.toMatchObject({
      campaignId,
      status: "QUEUED",
      audience: "all",
      total: 5,
      pending: 1,
      retry: 1,
      sent: 1,
      suppressed: 1,
      dead: 1,
    });
  });

  it("records retry_after on notification send failure", async () => {
    const customerId = await seedCustomer("111111");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "failure-retry-after",
    });
    const deliveryId = newId();
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id, status, attempts)
      values (${deliveryId}, ${campaignId}, ${customerId}, '111111', 'RETRY', 1)
    `.execute(ctx.db);

    await markNotificationFailure(ctx.db, deliveryId, 0, "telegram unavailable", 5);
    const row = await sql<{ status: string; retry_after: Date; last_error: string }>`
      select status, next_attempt_at as retry_after, last_error
      from notification_delivery where id = ${deliveryId}
    `.execute(ctx.db);

    expect(row.rows[0]?.status).toBe("RETRY");
    expect(row.rows[0]?.retry_after.getTime()).toBeGreaterThan(Date.now());
    expect(row.rows[0]?.last_error).toBe("telegram unavailable");
  });

  it("marks sent only after the responder accepts the outbound send", async () => {
    const customerId = await seedCustomer("111111");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "send-success",
    });
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${customerId}, '111111')`.execute(ctx.db);
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);

    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => undefined,
    });
    const row = await sql<{ status: string; sent_at: Date | null }>`select status, sent_at from notification_delivery where id=${claim!.id}`.execute(ctx.db);

    expect(result).toBe("SENT");
    expect(row.rows[0]).toMatchObject({ status: "SENT" });
    expect(row.rows[0]?.sent_at).toBeInstanceOf(Date);
  });

  it("keeps an accepted-but-stale responder send from overwriting a newer SENT generation", async () => {
    const customerId = await seedCustomer("111111");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "stale-send",
    });
    const deliveryId = newId();
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id, status, claim_generation) values (${deliveryId}, ${campaignId}, ${customerId}, '111111', 'RETRY', 2)`.execute(ctx.db);

    await markNotificationSent(ctx.db, deliveryId, 2);
    const result = await processNotificationDeliveryClaim(ctx.db, { id: deliveryId, campaignId, customerId, chatId: "111111", content: "hello", class: "CRITICAL_SERVICE",
      generation: 1 }, {
      send: async () => undefined,
    });
    const row = await sql<{ status: string; claim_generation: string }>`select status, claim_generation from notification_delivery where id=${deliveryId}`.execute(ctx.db);

    expect(result).toBe("STALE");
    expect(row.rows[0]).toEqual({ status: "SENT", claim_generation: "2" });
  });

  it("honors an explicit retry_after delay for failed notification sends", async () => {
    const customerId = await seedCustomer("111111");
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "retry-after-contract",
    });
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${customerId}, '111111')`.execute(ctx.db);
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    const error = new Error("rate limited");
    const before = Date.now();

    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => { throw error; },
    }, { maxAttempts: 5, retryAfterSeconds: () => 2 });
    const row = await sql<{ status: string; next_attempt_at: Date; last_error: string }>`select status, next_attempt_at, last_error from notification_delivery where id=${claim!.id}`.execute(ctx.db);
    const delayMs = row.rows[0]!.next_attempt_at.getTime() - before;

    expect(result).toBe("RETRY");
    expect(row.rows[0]?.status).toBe("RETRY");
    expect(delayMs).toBeGreaterThanOrEqual(1_500);
    expect(delayMs).toBeLessThan(30_000);
  });

  it("turns positive stock deltas into restock deliveries for actual subscribers", async () => {
    const variantId = await seedVariant();
    const subscribed = await seedCustomer("111111");
    const notSubscribed = await seedCustomer("222222");
    await subscribeRestock(ctx.db, subscribed, variantId);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${subscribed}, true, false), (${notSubscribed}, true, false)
    `.execute(ctx.db);
    await enqueueOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "DigitalAsset",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "StockDelta",
      payloadRedacted: { variantId, delta: 1, stockAfter: 1, announce: true },
    });

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 5,
      maxAttempts: 5,
      handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
    });
    const deliveries = await sql<{ customer_id: string; class: string; content: string }>`
      select d.customer_id, c.class, c.content
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
      order by d.customer_id
    `.execute(ctx.db);

    expect(drain.published).toBe(1);
    expect(deliveries.rows).toEqual([
      { customer_id: subscribed, class: "SHOP_UPDATE", content: "Sản phẩm bạn theo dõi đã có hàng lại." },
    ]);
  });
});
