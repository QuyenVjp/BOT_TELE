import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
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
  previewStockAnnouncementBroadcast,
} from "../../src/modules/notification/service.js";
import {
  createSealedNotificationResponder,
  marketingBroadcastClassForAudience,
} from "../../src/worker.js";
import { subscribeRestock } from "../../src/modules/catalog/restock.js";
import {
  confirmInventoryImportSession,
  stageInventoryImportInput,
  startInventoryImportSession,
} from "../../src/modules/digital-goods/inventory-import-session.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const ROOT_ID = 123456789;
const rootConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const rootActor = {
  numericUserId: ROOT_ID,
  chatType: "private" as const,
  observedUsername: "Quyenvjp",
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table admin_inventory_import, notification_delivery, notification_campaign, notification_preference,
      restock_subscription, channel_identity, customer_profile_snapshot, digital_asset,
      variant_quantity_stock, outbox_event, product_variant, product, category, customer cascade
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

async function seedStockVariant(input: {
  available: number;
  priceVnd?: number;
  active?: boolean;
  fulfillmentType?: "STOCK_ACCOUNT" | "STOCK_CODE" | "QUANTITY_STOCK" | "SUPPLIER_API";
}): Promise<string> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const fulfillmentType = input.fulfillmentType ?? "STOCK_ACCOUNT";
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Cat', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Product', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code,
      delivery_type, stock_policy, resale_evidence_id, is_active, fulfillment_type)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Variant', ${input.priceVnd ?? 100000}, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', ${input.active ?? true}, ${fulfillmentType})
  `.execute(ctx.db);
  if (fulfillmentType === "QUANTITY_STOCK") {
    await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${variantId}, ${input.available})`.execute(
      ctx.db,
    );
  } else {
    for (let index = 0; index < input.available; index += 1) {
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${newId()}, ${variantId}, 'LOCAL', ${"vault-" + variantId + "-" + index}, ${newId()}, 'AVAILABLE')
      `.execute(ctx.db);
    }
  }
  return variantId;
}

describe("notification service", () => {
  it("defaults missing customer notification preference to opt-out", async () => {
    const customerId = await seedCustomer("111111");

    const pref = await getNotificationPreferences(ctx.db, customerId);

    expect(pref.shopUpdates).toBe(false);
    expect(pref.purchaseActivity).toBe(false);
  });

  it("classifies marketing all as shop updates, not critical service", () => {
    expect(marketingBroadcastClassForAudience("all")).toBe("SHOP_UPDATE");
    expect(marketingBroadcastClassForAudience("shop")).toBe("SHOP_UPDATE");
    expect(marketingBroadcastClassForAudience("root")).toBe("SHOP_UPDATE");
    expect(marketingBroadcastClassForAudience("activity")).toBe("PURCHASE_ACTIVITY");
  });
  it("preserves omitted quiet hours and clears explicitly null hours", async () => {
    const customerId = await seedCustomer("111111");
    await setNotificationPreferences(ctx.db, {
      customerId,
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    expect(
      await setNotificationPreferences(ctx.db, { customerId, shopUpdates: true }),
    ).toMatchObject({ quietStart: "22:00:00", quietEnd: "07:00:00", shopUpdates: true });
    expect(
      await setNotificationPreferences(ctx.db, { customerId, quietStart: null, quietEnd: null }),
    ).toMatchObject({ quietStart: null, quietEnd: null, shopUpdates: true });
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
  it("claims critical service before older marketing work", async () => {
    const marketingCustomer = await seedCustomer("marketing");
    const criticalCustomer = await seedCustomer("critical");
    const marketingCampaign = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      queued: true,
      content: "marketing",
      createdBy: "admin",
      idempotencyKey: "priority-marketing",
    });
    const criticalCampaign = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      queued: true,
      content: "critical",
      createdBy: "admin",
      idempotencyKey: "priority-critical",
    });
    await sql`
      insert into notification_delivery(id,campaign_id,customer_id,chat_id,next_attempt_at)
      values
        (${newId()},${marketingCampaign},${marketingCustomer},'marketing',now()-interval '1 minute'),
        (${newId()},${criticalCampaign},${criticalCustomer},'critical',now())
    `.execute(ctx.db);

    const [critical] = await claimNotificationDeliveries(ctx.db, 1);
    const [marketing] = await claimNotificationDeliveries(ctx.db, 1);
    expect(critical?.class).toBe("CRITICAL_SERVICE");
    expect(marketing?.class).toBe("SHOP_UPDATE");
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
    expect(
      await markBroadcastPreviewed(ctx.db, {
        campaignId,
        createdBy: "wrong-admin",
        content: "Sale",
      }),
    ).toBe(false);
    expect(
      await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Sale" }),
    ).toBe(true);
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

  it("uses shop update opt-in for all-customer marketing preview and fanout", async () => {
    const optedIn = await seedCustomer("111111");
    const optedOut = await seedCustomer("222222");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${optedIn}, true, false), (${optedOut}, false, false)
    `.execute(ctx.db);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Marketing",
      createdBy: "admin",
      idempotencyKey: "all-marketing-consent",
      audience: "all",
    });

    expect(await previewBroadcastAudience(ctx.db, "all")).toBe(1);
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Marketing" });
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(1);
    const rows = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery order by customer_id
    `.execute(ctx.db);

    expect(rows.rows).toEqual([{ customer_id: optedIn }]);
  });

  it("builds contextual stock announcement as shop-update preview without fanout", async () => {
    const optedIn = await seedCustomer("111111");
    const optedOut = await seedCustomer("222222");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${optedIn}, true, false), (${optedOut}, false, false)
    `.execute(ctx.db);
    const variantId = await seedStockVariant({ available: 4, priceVnd: 99000 });

    const preview = await previewStockAnnouncementBroadcast(ctx.db, {
      variantId,
      createdBy: "admin",
      correlationId: "stock-preview",
    });

    expect(preview).toMatchObject({ audience: "shop", count: 1 });
    expect(preview?.content).toContain("Tồn kho hiện tại: 4");
    expect(preview?.content).toContain("Giá hiện tại: 99.000 ₫");
    expect(await enqueueBroadcastRecipients(ctx.db, preview!.campaignId)).toBe(1);
    const rows = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery order by customer_id
    `.execute(ctx.db);
    expect(rows.rows).toEqual([{ customer_id: optedIn }]);
  });

  it("keeps stock announcement preview as a persisted draft until explicit confirmation", async () => {
    const optedIn = await seedCustomer("111111");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${optedIn}, true, false)
    `.execute(ctx.db);
    const variantId = await seedStockVariant({ available: 4, priceVnd: 99000 });
    const first = await previewStockAnnouncementBroadcast(ctx.db, {
      variantId,
      createdBy: "admin",
      correlationId: "stock-repeat",
    });
    expect(first).toMatchObject({ audience: "shop", count: 1 });
    expect(
      Buffer.byteLength(`admin:marketing:confirm:${first!.campaignId}`, "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(await getBroadcastStatus(ctx.db, first!.campaignId)).toMatchObject({
      status: "DRAFT",
      total: 0,
    });

    await sql`update product_variant set price_vnd = 123000 where id = ${variantId}`.execute(
      ctx.db,
    );
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${newId()}, ${variantId}, 'LOCAL', 'vault-after-preview', ${newId()}, 'AVAILABLE')
    `.execute(ctx.db);
    const repeated = await previewStockAnnouncementBroadcast(ctx.db, {
      variantId,
      createdBy: "admin",
      correlationId: "stock-repeat",
    });

    expect(repeated?.campaignId).toBe(first?.campaignId);
    expect(repeated?.content).toBe(first?.content);
    expect(await enqueueBroadcastRecipients(ctx.db, first!.campaignId)).toBe(1);
    const deliveries = await sql<{ customer_id: string; content: string }>`
      select d.customer_id, c.content
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
    `.execute(ctx.db);
    expect(deliveries.rows).toEqual([{ customer_id: optedIn, content: first!.content }]);
  });

  it("cancels stock announcement drafts without later enqueue", async () => {
    const optedIn = await seedCustomer("111111");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${optedIn}, true, false)
    `.execute(ctx.db);
    const variantId = await seedStockVariant({ available: 2 });
    const preview = await previewStockAnnouncementBroadcast(ctx.db, {
      variantId,
      createdBy: "admin",
      correlationId: "stock-cancel",
    });

    expect(preview).toBeTruthy();
    expect(await cancelBroadcast(ctx.db, preview!.campaignId)).toBe(0);
    expect(await enqueueBroadcastRecipients(ctx.db, preview!.campaignId)).toBe(0);
    const rows = await sql<{
      count: string;
    }>`select count(*)::text as count from notification_delivery`.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("targets stock announcements to shop-update opt-ins, not restock subscribers", async () => {
    const optedIn = await seedCustomer("111111");
    const optedOut = await seedCustomer("222222");
    const restockOnly = await seedCustomer("333333");
    const variantId = await seedStockVariant({ available: 3 });
    await subscribeRestock(ctx.db, restockOnly, variantId);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${optedIn}, true, false), (${optedOut}, false, false), (${restockOnly}, false, false)
    `.execute(ctx.db);
    const preview = await previewStockAnnouncementBroadcast(ctx.db, {
      variantId,
      createdBy: "admin",
      correlationId: "stock-consent",
    });

    expect(preview).toMatchObject({ audience: "shop", count: 1 });
    expect(await enqueueBroadcastRecipients(ctx.db, preview!.campaignId)).toBe(1);
    const rows = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery order by customer_id
    `.execute(ctx.db);
    expect(rows.rows).toEqual([{ customer_id: optedIn }]);
    expect(rows.rows).not.toContainEqual({ customer_id: optedOut });
    expect(rows.rows).not.toContainEqual({ customer_id: restockOnly });
  });

  it("rejects zero-stock, inactive, and unsupported stock announcements", async () => {
    for (const variantId of [
      await seedStockVariant({ available: 0 }),
      await seedStockVariant({ available: 2, active: false }),
      await seedStockVariant({ available: 2, fulfillmentType: "SUPPLIER_API" }),
    ]) {
      await expect(
        previewStockAnnouncementBroadcast(ctx.db, {
          variantId,
          createdBy: "admin",
          correlationId: `stock-reject-${variantId}`,
        }),
      ).resolves.toBeNull();
    }
    const campaigns = await sql<{
      count: string;
    }>`select count(*)::text as count from notification_campaign`.execute(ctx.db);
    expect(campaigns.rows[0]?.count).toBe("0");
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
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Owner preview",
    });
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
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Owner preview",
    });
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
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Service notice",
    });
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id, status)
      values (${newId()}, ${campaignId}, ${sentCustomer}, '111111', 'SENT'),
             (${newId()}, ${campaignId}, ${retryCustomer}, '222222', 'RETRY'),
             (${newId()}, ${campaignId}, ${pendingCustomer}, '333333', 'PENDING')
    `.execute(ctx.db);

    expect(await cancelBroadcast(ctx.db, campaignId)).toBe(2);
    const deliveriesAfterCancel = await sql<{
      customer_id: string;
      status: string;
      last_error: string | null;
    }>`
      select customer_id, status, last_error from notification_delivery order by customer_id
    `.execute(ctx.db);
    await seedCustomer("444444");
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(0);
    const status = await getBroadcastStatus(ctx.db, campaignId);

    expect(deliveriesAfterCancel.rows).toEqual(
      [
        { customer_id: pendingCustomer, status: "SUPPRESSED", last_error: "admin_cancelled" },
        { customer_id: retryCustomer, status: "SUPPRESSED", last_error: "admin_cancelled" },
        { customer_id: sentCustomer, status: "SENT", last_error: null },
      ].sort((a, b) => a.customer_id.localeCompare(b.customer_id)),
    );
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
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${customerId}, '111111')`.execute(
      ctx.db,
    );
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);

    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => undefined,
    });
    const row = await sql<{
      status: string;
      sent_at: Date | null;
    }>`select status, sent_at from notification_delivery where id=${claim!.id}`.execute(ctx.db);

    expect(result).toBe("SENT");
    expect(row.rows[0]).toMatchObject({ status: "SENT" });
    expect(row.rows[0]?.sent_at).toBeInstanceOf(Date);
  });

  it("suppresses shop update delivery at send time after customer opts out", async () => {
    const customerId = await seedCustomer("111111");
    await setNotificationPreferences(ctx.db, { customerId, shopUpdates: true });
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      queued: true,
      content: "hello",
      createdBy: "admin",
      idempotencyKey: "send-time-opt-out",
    });
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${customerId}, '111111')`.execute(
      ctx.db,
    );
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    await setNotificationPreferences(ctx.db, { customerId, shopUpdates: false });
    let sent = 0;

    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => {
        sent += 1;
      },
    });
    const row = await sql<{
      status: string;
      last_error: string | null;
    }>`select status, last_error from notification_delivery where id=${claim!.id}`.execute(ctx.db);

    expect(result).toBe("SUPPRESSED");
    expect(sent).toBe(0);
    expect(row.rows[0]).toEqual({ status: "SUPPRESSED", last_error: "preference_opt_out" });
  });

  it("keeps critical service all-customer fanout and delivery independent of marketing opt-out", async () => {
    const customerId = await seedCustomer("111111");
    await setNotificationPreferences(ctx.db, {
      customerId,
      shopUpdates: false,
      purchaseActivity: false,
    });
    const campaignId = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "security notice",
      createdBy: "admin",
      idempotencyKey: "critical-service-opt-out",
      audience: "all",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "security notice",
    });
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(1);
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    let sent = 0;

    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => {
        sent += 1;
      },
    });

    expect(result).toBe("SENT");
    expect(sent).toBe(1);
  });

  it("keeps consent contracts distinct across preview, fanout, and send time", async () => {
    const shopOnly = await seedCustomer("111111");
    const activityOnly = await seedCustomer("222222");
    const optedOut = await seedCustomer("333333");
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${shopOnly}, true, false), (${activityOnly}, false, true), (${optedOut}, false, false)
    `.execute(ctx.db);

    const shopCampaign = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "shop",
      createdBy: "admin",
      idempotencyKey: "consent-shop",
      audience: "shop",
    });
    const activityCampaign = await createBroadcast(ctx.db, {
      class: "PURCHASE_ACTIVITY",
      content: "activity",
      createdBy: "admin",
      idempotencyKey: "consent-activity",
      audience: "activity",
    });
    const criticalCampaign = await createBroadcast(ctx.db, {
      class: "CRITICAL_SERVICE",
      content: "critical",
      createdBy: "admin",
      idempotencyKey: "consent-critical",
      audience: "all",
    });

    expect(await previewBroadcastAudience(ctx.db, "shop")).toBe(1);
    expect(await previewBroadcastAudience(ctx.db, "activity")).toBe(1);
    await markBroadcastPreviewed(ctx.db, {
      campaignId: shopCampaign,
      createdBy: "admin",
      content: "shop",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId: activityCampaign,
      createdBy: "admin",
      content: "activity",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId: criticalCampaign,
      createdBy: "admin",
      content: "critical",
    });
    expect(await enqueueBroadcastRecipients(ctx.db, shopCampaign)).toBe(1);
    expect(await enqueueBroadcastRecipients(ctx.db, activityCampaign)).toBe(1);
    expect(await enqueueBroadcastRecipients(ctx.db, criticalCampaign)).toBe(3);

    const fannedOut = await sql<{ class: string; customer_id: string }>`
      select c.class, d.customer_id
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
      order by c.class, d.customer_id
    `.execute(ctx.db);
    expect(fannedOut.rows).toHaveLength(5);
    expect(fannedOut.rows).toEqual(
      expect.arrayContaining([
        { class: "CRITICAL_SERVICE", customer_id: activityOnly },
        { class: "CRITICAL_SERVICE", customer_id: optedOut },
        { class: "CRITICAL_SERVICE", customer_id: shopOnly },
        { class: "PURCHASE_ACTIVITY", customer_id: activityOnly },
        { class: "SHOP_UPDATE", customer_id: shopOnly },
      ]),
    );

    await setNotificationPreferences(ctx.db, { customerId: activityOnly, purchaseActivity: false });
    let sent = 0;
    for (const claim of await claimNotificationDeliveries(ctx.db, 10)) {
      const result = await processNotificationDeliveryClaim(ctx.db, claim, {
        send: async () => {
          sent += 1;
        },
      });
      if (claim.class === "PURCHASE_ACTIVITY") expect(result).toBe("SUPPRESSED");
      if (claim.class === "SHOP_UPDATE" || claim.class === "CRITICAL_SERVICE")
        expect(result).toBe("SENT");
    }
    expect(sent).toBe(4);
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
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id, status, claim_generation) values (${deliveryId}, ${campaignId}, ${customerId}, '111111', 'RETRY', 2)`.execute(
      ctx.db,
    );

    await markNotificationSent(ctx.db, deliveryId, 2);
    const result = await processNotificationDeliveryClaim(
      ctx.db,
      {
        id: deliveryId,
        campaignId,
        customerId,
        chatId: "111111",
        content: "hello",
        class: "CRITICAL_SERVICE",
        generation: 1,
      },
      {
        send: async () => undefined,
      },
    );
    const row = await sql<{
      status: string;
      claim_generation: string;
    }>`select status, claim_generation from notification_delivery where id=${deliveryId}`.execute(
      ctx.db,
    );

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
    await sql`insert into notification_delivery(id, campaign_id, customer_id, chat_id) values (${newId()}, ${campaignId}, ${customerId}, '111111')`.execute(
      ctx.db,
    );
    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    const error = new Error("rate limited");
    const before = Date.now();

    const result = await processNotificationDeliveryClaim(
      ctx.db,
      claim!,
      {
        send: async () => {
          throw error;
        },
      },
      { maxAttempts: 5, retryAfterSeconds: () => 2 },
    );
    const row = await sql<{
      status: string;
      next_attempt_at: Date;
      last_error: string;
    }>`select status, next_attempt_at, last_error from notification_delivery where id=${claim!.id}`.execute(
      ctx.db,
    );
    const delayMs = row.rows[0]!.next_attempt_at.getTime() - before;

    expect(result).toBe("RETRY");
    expect(row.rows[0]?.status).toBe("RETRY");
    expect(delayMs).toBeGreaterThanOrEqual(1_500);
    expect(delayMs).toBeLessThan(30_000);
  });

  it("turns positive stock deltas into detailed restock deliveries for actual subscribers", async () => {
    const variantId = await seedVariant();
    const subscribed = await seedCustomer("111111");
    const notSubscribed = await seedCustomer("222222");
    await subscribeRestock(ctx.db, subscribed, variantId);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${subscribed}, false, false), (${notSubscribed}, true, false)
    `.execute(ctx.db);
    await enqueueOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "DigitalAsset",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "StockDelta",
      payloadRedacted: { variantId, delta: 3, stockAfter: 3 },
    });

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 5,
      maxAttempts: 5,
      handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
    });
    const deliveries = await sql<{
      customer_id: string;
      class: string;
      content: string;
      product_variant_id: string | null;
    }>`
      select d.customer_id, c.class, c.content, c.product_variant_id
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
      order by d.customer_id
    `.execute(ctx.db);

    expect(await getNotificationPreferences(ctx.db, subscribed)).toMatchObject({
      shopUpdates: false,
    });
    expect(drain.published).toBe(1);
    expect(deliveries.rows).toEqual([
      {
        customer_id: subscribed,
        class: "SHOP_UPDATE",
        product_variant_id: variantId,
        content: [
          "Sản phẩm bạn theo dõi đã có hàng lại.",
          "Sản phẩm: Product",
          "Gói: Variant",
          "Mới thêm: 3",
          "Tồn kho hiện tại: 3",
          "Giá hiện tại: 100.000 ₫",
        ].join("\n"),
      },
    ]);

    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    let sentButtons: Array<Array<{ text: string; callbackData: string }>> = [];
    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async (input) => {
        sentButtons = input.message.buttons;
      },
    });

    expect(result).toBe("SENT");
    expect(sentButtons).toEqual([
      [{ text: "Xem sản phẩm", callbackData: `var:view:${variantId}` }],
    ]);
  });

  it("seals notification product buttons for the Telegram user, not the chat id", async () => {
    const variantId = newId();
    const codec = createCallbackTokenCodec({
      key: "test-only-notification-button-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    let sealed = "";
    const responder = createSealedNotificationResponder({
      codec,
      resolveOrderId: async () => null,
      responder: {
        send: async (input) => {
          sealed = input.message.buttons[0]![0]!.callbackData;
        },
      },
    });

    await responder.send({
      chatId: "chat-999",
      telegramUserId: "123456789",
      messageId: null,
      message: {
        text: "restock",
        buttons: [[{ text: "Xem sản phẩm", callbackData: `var:view:${variantId}` }]],
      },
    });

    expect(sealed).toMatch(/^cb:/);
    expect(codec.verify(sealed, { telegramUserId: "chat-999" }).ok).toBe(false);
    expect(codec.verify(sealed, { telegramUserId: "123456789" })).toMatchObject({
      ok: true,
      value: { action: "VARIANT_VIEW", resourceId: variantId },
    });
  });

  it("delivers once per selected-variant restock import generation and never as context marketing", async () => {
    const vault = createInMemoryVault();
    const variantId = await seedStockVariant({ available: 0 });
    const otherVariantId = await seedStockVariant({ available: 0 });
    const subscribed = await seedCustomer("111111");
    const otherSubscriber = await seedCustomer("222222");
    const shopOnly = await seedCustomer("333333");
    await subscribeRestock(ctx.db, subscribed, variantId);
    await subscribeRestock(ctx.db, otherSubscriber, otherVariantId);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${subscribed}, false, false), (${otherSubscriber}, false, false), (${shopOnly}, true, false)
    `.execute(ctx.db);

    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "restock-import:first-start",
      variantId,
    });
    await expect(
      stageInventoryImportInput(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "restock-import:first-stage",
        rawInput: "first-secret",
      }),
    ).resolves.toMatchObject({ ok: true, preview: { ready: 1, invalid: 0, duplicates: 0 } });
    await expect(
      sql<{ count: string }>`select count(*)::text as count from notification_campaign`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      confirmInventoryImportSession(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "restock-import:first-confirm",
      }),
    ).resolves.toMatchObject({ ok: true, summary: { imported: 1, duplicates: 0, invalid: 0 } });
    await expect(
      sql<{ count: string }>`select count(*)::text as count from notification_campaign`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      drainOutboxOnce(ctx.db, {
        batchSize: 5,
        maxAttempts: 5,
        handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
      }),
    ).resolves.toMatchObject({ failed: 0 });

    await sql`
      update digital_asset set status='RESERVED', reserved_until=now()+interval '1 hour'
      where variant_id=${variantId} and status='AVAILABLE'
    `.execute(ctx.db);
    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "restock-import:second-start",
      variantId,
    });
    await expect(
      stageInventoryImportInput(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "restock-import:second-stage",
        rawInput: "second-secret",
      }),
    ).resolves.toMatchObject({ ok: true, preview: { ready: 1, invalid: 0, duplicates: 0 } });
    await expect(
      confirmInventoryImportSession(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "restock-import:second-confirm",
      }),
    ).resolves.toMatchObject({ ok: true, summary: { imported: 1, duplicates: 0, invalid: 0 } });
    await expect(
      drainOutboxOnce(ctx.db, {
        batchSize: 5,
        maxAttempts: 5,
        handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
      }),
    ).resolves.toMatchObject({ failed: 0 });

    const beforeReplay = await sql<{
      count: string;
    }>`select count(*)::text as count from notification_delivery`.execute(ctx.db);
    await sql`update outbox_event set published_at=null, next_attempt_at=null where event_type='StockDelta'`.execute(
      ctx.db,
    );
    await drainOutboxOnce(ctx.db, {
      batchSize: 10,
      maxAttempts: 5,
      handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
    });
    const deliveries = await sql<{
      customer_id: string;
      product_variant_id: string | null;
      class: string;
    }>`
      select d.customer_id, c.product_variant_id, c.class
      from notification_delivery d join notification_campaign c on c.id=d.campaign_id
      order by c.created_at, c.id
    `.execute(ctx.db);

    expect(beforeReplay.rows[0]?.count).toBe("2");
    expect(deliveries.rows).toEqual([
      { customer_id: subscribed, product_variant_id: variantId, class: "SHOP_UPDATE" },
      { customer_id: subscribed, product_variant_id: variantId, class: "SHOP_UPDATE" },
    ]);
  });

  it("turns low stock deltas into replay-safe root admin critical deliveries", async () => {
    const variantId = await seedVariant();
    const root = await seedCustomer("42");
    const eventId = newId();
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "QuantityStock",
      aggregateId: variantId,
      aggregateVersion: 2,
      eventType: "StockDelta",
      payloadRedacted: {
        variantId,
        delta: -1,
        stockAfter: 1,
        source: "QUANTITY",
        lowStockAlert: true,
        threshold: 1,
      },
    });

    const handler = (event: Parameters<typeof handleNotificationOutboxEvent>[1]) =>
      handleNotificationOutboxEvent(ctx.db, event, { rootTelegramUserId: 42 });
    const first = await drainOutboxOnce(ctx.db, { batchSize: 5, maxAttempts: 5, handler });
    await sql`update outbox_event set published_at = null, next_attempt_at = null where id = ${eventId}`.execute(
      ctx.db,
    );
    const replay = await drainOutboxOnce(ctx.db, { batchSize: 5, maxAttempts: 5, handler });
    const deliveries = await sql<{ customer_id: string; class: string; content: string }>`
      select d.customer_id, c.class, c.content
      from notification_delivery d join notification_campaign c on c.id = d.campaign_id
    `.execute(ctx.db);

    expect(first.published).toBe(1);
    expect(replay.published).toBe(1);
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0]).toMatchObject({ customer_id: root, class: "CRITICAL_SERVICE" });
    expect(deliveries.rows[0]?.content).toContain("ngưỡng 1");
  });

  it("retries low stock deltas when root admin notification target is missing", async () => {
    const variantId = await seedVariant();
    await enqueueOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "DigitalAsset",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "StockDelta",
      payloadRedacted: {
        variantId,
        delta: -1,
        stockAfter: 1,
        source: "DISCRETE",
        lowStockAlert: true,
        threshold: 1,
      },
    });

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 5,
      maxAttempts: 5,
      handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
    });
    const state = await sql<{ published_at: Date | null; last_error_code: string | null }>`
      select published_at, last_error_code from outbox_event
    `.execute(ctx.db);

    expect(drain).toMatchObject({ published: 0, failed: 1 });
    expect(state.rows[0]).toMatchObject({
      published_at: null,
      last_error_code: "LOW_STOCK_ROOT_NOTIFICATION_TARGET_MISSING",
    });
  });

  it("marks discrete asset threshold crossings as low-stock alerts", async () => {
    const variantId = await seedVariant();
    await sql`update product_variant set low_stock_threshold = 1 where id = ${variantId}`.execute(
      ctx.db,
    );
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values
        (${newId()}, ${variantId}, 'LOCAL', 'vault-1', ${newId()}, 'AVAILABLE'),
        (${newId()}, ${variantId}, 'LOCAL', 'vault-2', ${newId()}, 'AVAILABLE')
    `.execute(ctx.db);
    await sql`delete from outbox_event`.execute(ctx.db);

    await sql`
      update digital_asset
      set status = 'RESERVED', reserved_until = now() + interval '1 hour'
      where id = (select id from digital_asset where variant_id = ${variantId} and status = 'AVAILABLE' limit 1)
    `.execute(ctx.db);

    const event = await sql<{ payload_redacted: Record<string, unknown> }>`
      select payload_redacted from outbox_event where event_type = 'StockDelta'
    `.execute(ctx.db);

    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.payload_redacted).toMatchObject({
      variantId,
      source: "DISCRETE",
      delta: -1,
      stockAfter: 1,
      lowStockAlert: true,
      threshold: 1,
    });
  });

  it("emits one discrete low-stock alert while many buyers reserve concurrently", async () => {
    const variantId = await seedVariant();
    await sql`update product_variant set low_stock_threshold = 50 where id = ${variantId}`.execute(
      ctx.db,
    );
    const assetIds = Array.from({ length: 100 }, () => newId());
    for (let index = 0; index < assetIds.length; index += 1) {
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${assetIds[index]}, ${variantId}, 'LOCAL', ${`vault-${index}`}, ${newId()}, 'AVAILABLE')
      `.execute(ctx.db);
    }
    await sql`delete from outbox_event`.execute(ctx.db);

    await Promise.all(
      assetIds.map((assetId) =>
        sql`
          update digital_asset
          set status = 'RESERVED', reserved_until = now() + interval '1 hour'
          where id = ${assetId}
        `.execute(ctx.db),
      ),
    );

    const alerts = await sql<{ count: string }>`
      select count(*)::text as count
      from outbox_event
      where event_type = 'StockDelta'
        and payload_redacted->>'source' = 'DISCRETE'
        and payload_redacted->>'lowStockAlert' = 'true'
        and payload_redacted->>'threshold' = '50'
    `.execute(ctx.db);

    expect(alerts.rows[0]?.count).toBe("1");
  });

  // Warranty notices: the owner is told the moment a claim arrives, and the customer is told at each
  // resolution — without a credential in either message and without claiming money that has not
  // moved.
  it("queues the admin alert for a new claim and the customer notices at each resolution", async () => {
    const customerId = await seedCustomer("777001");
    const claimId = newId();
    // the admin alert resolves the owner through channel_identity
    const rootChatId = "424242";
    await seedCustomer(rootChatId);
    const rootTelegramUserId = Number(rootChatId);

    const opened = await handleNotificationOutboxEvent(
      ctx.db,
      {
        id: newId(),
        aggregateType: "WarrantyClaim",
        aggregateId: claimId,
        aggregateVersion: 1,
        eventType: "WarrantyClaimOpened",
        payloadRedacted: {
          claimId,
          claimNumber: "BH-ABC123",
          orderNumber: "ORD-TEST-1",
          customerId,
          issueType: "LOST_BENEFITS",
          usedDays: 18,
          remainingDays: 12,
          calculatedRefundVnd: "40000",
        },
        attemptCount: 0,
        claimedBy: "test",
        generation: 1,
      },
      { rootTelegramUserId },
    );
    expect(opened).toMatchObject({ kind: "PUBLISHED" });

    const adminCampaign = await sql<{ content: string; class: string }>`
      select content, class from notification_campaign where id = ${`warranty-opened:${claimId}`}
    `.execute(ctx.db);
    expect(adminCampaign.rows[0]).toMatchObject({ class: "CRITICAL_SERVICE" });
    expect(adminCampaign.rows[0]!.content).toContain("YÊU CẦU BẢO HÀNH MỚI");
    expect(adminCampaign.rows[0]!.content).toContain("40.000");
    expect(adminCampaign.rows[0]!.content).toContain("Còn bảo hành: 12 ngày");
    // Goal §16 words the symptom the way the customer's own screen does, and no internal code or
    // state name ever reaches the owner's chat.
    expect(adminCampaign.rows[0]!.content).toContain("Mất gói");
    expect(adminCampaign.rows[0]!.content).not.toMatch(
      /LOST_BENEFITS|ACCOUNT_LOCKED|CANNOT_SIGN_IN|WarrantyClaimOpened|SUBMITTED/,
    );

    const due = await handleNotificationOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "WarrantyClaim",
      aggregateId: claimId,
      aggregateVersion: 1,
      eventType: "WarrantyRefundDue",
      payloadRedacted: { claimId, customerId, amountVnd: "40000" },
      attemptCount: 0,
      claimedBy: "test",
      generation: 1,
    });
    expect(due).toMatchObject({ kind: "PUBLISHED" });
    const dueCampaign = await sql<{ content: string }>`
      select content from notification_campaign where id = ${`warranty-refund-due:${claimId}`}
    `.execute(ctx.db);
    expect(dueCampaign.rows[0]!.content).toContain("Chờ shop chuyển tiền");
    // it must not claim the money already moved
    expect(dueCampaign.rows[0]!.content).not.toContain("Đã hoàn tiền");

    const paid = await handleNotificationOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "WarrantyClaim",
      aggregateId: claimId,
      aggregateVersion: 1,
      eventType: "WarrantyRefundPaid",
      payloadRedacted: { claimId, customerId, amountVnd: "40000" },
      attemptCount: 0,
      claimedBy: "test",
      generation: 1,
    });
    expect(paid).toMatchObject({ kind: "PUBLISHED" });
    const paidCampaign = await sql<{ content: string }>`
      select content from notification_campaign where id = ${`warranty-refund-paid:${claimId}`}
    `.execute(ctx.db);
    expect(paidCampaign.rows[0]!.content).toContain("Shop đã xác nhận chuyển khoản");
  });
});
