import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import { newId } from "../../src/shared/ids/index.js";
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
    truncate table delivery_bundle, digital_asset, supplier_order, supplier_sku, supplier,
      order_transition, outbox_event, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedSupplierPaidOrder() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const supplierId = newId();
  const supplierSkuId = newId();
  const externalSku = `SUP-${newId().slice(-8)}`;

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, supplier_sku_id, resale_evidence_id, fulfillment_type)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 199000, 'P1M',
       'CREDENTIAL', 'SUPPLIER_ONLY', ${supplierSkuId}, 'RES-1', 'SUPPLIER_API')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, fulfillment_type, status, paid_at)
    values
      (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
       199000, 'P1M', 'CREDENTIAL', 'SUPPLIER_API', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values (${supplierId}, 'Primary', 'sandbox', 'vault:sup-cred', 'ACTIVE')
  `.execute(ctx.db);
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values (${supplierSkuId}, ${supplierId}, ${variantId}, ${externalSku}, 120000, 'VN', 'CREDENTIAL', true)
  `.execute(ctx.db);

  return { orderId, customerId, variantId, supplierId, supplierSkuId };
}

async function enqueueOrderPaid(orderId: string, correlationId: string) {
  const eventId = newId();
  await enqueueOutboxEvent(ctx.db, {
    id: eventId,
    aggregateType: "Order",
    aggregateId: orderId,
    aggregateVersion: 2,
    eventType: "OrderPaid",
    payloadRedacted: { orderId, correlationId },
  });
  return eventId;
}
async function attemptSupplierFulfillment(gate?: () => boolean) {
  const fixture = await seedSupplierPaidOrder();
  const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
  let createCalls = 0;
  const supplier = {
    ...sandbox,
    async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
      createCalls += 1;
      return sandbox.createOrder(input);
    },
  };
  const result = await fulfillPaidOrder(ctx.db, {
    orderId: fixture.orderId,
    correlationId: "purchase-gate-regression",
    deps: {
      vault: createInMemoryVault(),
      supplier,
      ...(gate ? { supplierPurchaseEnabled: gate } : {}),
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    },
  });
  return { fixture, result, createCalls };
}

async function supplierOrderCount(orderId: string): Promise<number> {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from supplier_order where order_id = ${orderId}
  `.execute(ctx.db);
  return rows.rows[0]?.count ?? 0;
}

describe("supplier fulfillment from OrderPaid", () => {
  it("fails closed when the supplier purchase dependency is absent", async () => {
    const attempt = await attemptSupplierFulfillment();
    expect(attempt.result).toMatchObject({ ok: false, code: "SUPPLIER_UNSUPPORTED" });
    expect(attempt.createCalls).toBe(0);
    expect(await supplierOrderCount(attempt.fixture.orderId)).toBe(0);
  });

  it.each(["generic gate disabled", "provider gate disabled"])(
    "fails closed when the %s",
    async () => {
      const attempt = await attemptSupplierFulfillment(() => false);
      expect(attempt.result).toMatchObject({ ok: false, code: "SUPPLIER_UNSUPPORTED" });
      expect(attempt.createCalls).toBe(0);
      expect(await supplierOrderCount(attempt.fixture.orderId)).toBe(0);
    },
  );

  it("executes the supplier boundary only for an explicit allowed gate", async () => {
    const attempt = await attemptSupplierFulfillment(() => true);
    expect(attempt.result.ok).toBe(true);
    expect(attempt.createCalls).toBe(1);
    expect(await supplierOrderCount(attempt.fixture.orderId)).toBe(1);
  });

  it("drains a paid supplier order into one supplier asset and delivery bundle", async () => {
    const f = await seedSupplierPaidOrder();
    const eventId = await enqueueOrderPaid(f.orderId, "supplier-paid");
    const vault = createInMemoryVault();
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault,
      supplier: createSandboxSupplierAdapter({ mode: "fulfill" }),
      supplierPurchaseEnabled: () => true,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });

    await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });

    const event = await sql<{
      published: boolean;
    }>`select (published_at is not null) as published from outbox_event where id = ${eventId}`.execute(
      ctx.db,
    );
    expect(event.rows[0]?.published).toBe(true);
    const asset = await sql<{
      source_type: string;
      status: string;
      reserved_order_id: string | null;
    }>`select source_type, status, reserved_order_id from digital_asset where reserved_order_id = ${f.orderId}`.execute(
      ctx.db,
    );
    expect(asset.rows).toEqual([
      { source_type: "SUPPLIER", status: "READY", reserved_order_id: f.orderId },
    ]);
    const bundles = await sql<{
      count: number;
    }>`select count(*)::int as count from delivery_bundle where order_id = ${f.orderId}`.execute(
      ctx.db,
    );
    expect(bundles.rows[0]?.count).toBe(1);
  });

  it("retries a supplier timeout, recovers by query, then replays without duplicate effects", async () => {
    const f = await seedSupplierPaidOrder();
    const eventId = await enqueueOrderPaid(f.orderId, "supplier-timeout");
    const vault = createInMemoryVault();
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault,
      supplier: createSandboxSupplierAdapter({ mode: "timeout-then-fulfill" }),
      supplierPurchaseEnabled: () => true,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });

    await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });
    const afterTimeout = await sql<{
      published: boolean;
      last_error_code: string | null;
    }>`select (published_at is not null) as published, last_error_code from outbox_event where id = ${eventId}`.execute(
      ctx.db,
    );
    expect(afterTimeout.rows[0]).toEqual({ published: false, last_error_code: "SUPPLIER_PENDING" });

    await sql`update outbox_event set next_attempt_at = now(), claimed_by = null, claim_expires_at = null where id = ${eventId}`.execute(
      ctx.db,
    );
    await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });
    const afterRecovery = await sql<{
      published: boolean;
    }>`select (published_at is not null) as published from outbox_event where id = ${eventId}`.execute(
      ctx.db,
    );
    expect(afterRecovery.rows[0]?.published).toBe(true);

    await handler({
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "supplier-timeout" },
      attemptCount: 2,
      claimedBy: "replay-fixture",
      generation: 2,
    });

    const counts = await sql<{ assets: number; orders: number; bundles: number }>`
      select
        (select count(*)::int from digital_asset where reserved_order_id = ${f.orderId}) as assets,
        (select count(*)::int from supplier_order where order_id = ${f.orderId}) as orders,
        (select count(*)::int from delivery_bundle where order_id = ${f.orderId}) as bundles
    `.execute(ctx.db);
    expect(counts.rows[0]).toEqual({ assets: 1, orders: 1, bundles: 1 });
  });
  it("replays a completed supplier order without a second supplier create or delivery bundle", async () => {
    const f = await seedSupplierPaidOrder();
    const eventId = await enqueueOrderPaid(f.orderId, "supplier-completed-replay");
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
    let createCount = 0;
    const supplier = {
      ...sandbox,
      async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
        createCount += 1;
        return sandbox.createOrder(input);
      },
    };
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault,
      supplier,
      supplierPurchaseEnabled: () => true,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });

    await drainOutboxOnce(ctx.db, { batchSize: 10, maxAttempts: 5, handler });
    await sql`update "order" set status = 'COMPLETED' where id = ${f.orderId}`.execute(ctx.db);

    const event = await sql<{
      published: boolean;
    }>`select (published_at is not null) as published from outbox_event where id = ${eventId}`.execute(
      ctx.db,
    );
    expect(event.rows[0]?.published).toBe(true);

    await handler({
      id: eventId,
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "supplier-completed-replay" },
      attemptCount: 2,
      claimedBy: "completed-replay-fixture",
      generation: 2,
    });

    const counts = await sql<{ assets: number; orders: number; bundles: number }>`
      select
        (select count(*)::int from digital_asset where reserved_order_id = ${f.orderId}) as assets,
        (select count(*)::int from supplier_order where order_id = ${f.orderId}) as orders,
        (select count(*)::int from delivery_bundle where order_id = ${f.orderId}) as bundles
    `.execute(ctx.db);
    expect(counts.rows[0]).toEqual({ assets: 1, orders: 1, bundles: 1 });
    expect(createCount).toBe(1);
  });
});
