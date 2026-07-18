import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { createFulfillmentTelemetry } from "../../src/modules/digital-goods/telemetry.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T076 — Payment outbox → fulfillment worker (FR-013, SR-006).
 *
 * Draining an OrderPaid outbox event claims the local asset, issues a Delivery
 * Bundle, and notifies the customer. Replaying the same event is a no-op on
 * domain effects (one asset, one bundle).
 */

let ctx: PgTestContext;
const DELIVERY_SESSION_CONFIG = {
  key: "test-only-handler-delivery-session-key-material-123456",
  keyVersion: 1,
  audience: "delivery-reveal",
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  customerId: string;
  assetId: string;
  vault: ReturnType<typeof createInMemoryVault>;
}

async function seedPaidWithAsset(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("HANDLER-SECRET");
  const slug = categoryId.slice(-8);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', '123456789')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'AVAILABLE')
  `.execute(ctx.db);

  return { orderId, customerId, assetId, vault };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_capability_compensation, delivery_notification_handoff,
      delivery_session, delivery_bundle,
      channel_identity, digital_asset, order_transition, outbox_event, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("fulfillment outbox handlers (T076)", () => {
  it("OrderPaid drains into a claimed asset + Delivery Bundle + notification", async () => {
    const f = await seedPaidWithAsset();

    await enqueueOutboxEvent(ctx.db, {
      id: newId(),
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: {
        orderId: f.orderId,
        correlationId: "h1",
      },
    });

    const telemetry = createFulfillmentTelemetry();
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      telemetry,
      deliverySession: {
        config: DELIVERY_SESSION_CONFIG,
        ttlSeconds: 300,
      },
    });

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 10,
      maxAttempts: 5,
      handler,
    });
    expect(drain.published).toBe(1);

    const asset = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${f.assetId}
    `.execute(ctx.db);
    expect(["RESERVED", "READY", "DELIVERED"]).toContain(asset.rows[0]?.status);
    expect(asset.rows[0]?.reserved_order_id).toBe(f.orderId);

    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
    const handoffs = await sql<{ customer_id: string; telegram_chat_id: string }>`
      select customer_id, telegram_chat_id from delivery_notification_handoff
    `.execute(ctx.db);
    expect(handoffs.rows).toEqual([{ customer_id: f.customerId, telegram_chat_id: "123456789" }]);
  });

  it("replaying OrderPaid is idempotent (one asset, one bundle)", async () => {
    const f = await seedPaidWithAsset();
    const eventId = newId();
    // First publish.
    await enqueueOutboxEvent(ctx.db, {
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "h1" },
    });

    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: f.vault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });

    await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });

    // Manually re-invoke the handler (simulates at-least-once redelivery after
    // a crash between effect and ack).
    await handler({
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "h1" },
      attemptCount: 1,
      claimedBy: "replay-fixture",
      generation: 1,
    });

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where reserved_order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);
    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
  });
});
