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

  return { orderId, customerId, productId, variantId, supplierId, supplierSkuId, externalSku };
}

type CatalogState = {
  availability: "AVAILABLE" | "LOW" | "OUT" | "UNKNOWN" | "MISSING";
  domainStatus: "SUPPORTED" | "UNSUPPORTED";
  selectionStatus: "DISCOVERED" | "SELECTED";
  enabled: boolean;
  missing: boolean;
  reason: string | null;
};
type MappingMutation = "SUPPLIER_DISABLED" | "SKU_DISABLED" | "PRIMARY_CLEARED";

async function makeCatalogManaged(
  fixture: Awaited<ReturnType<typeof seedSupplierPaidOrder>>,
): Promise<void> {
  await sql`
    update supplier
    set provider_capabilities = '["CATALOG_LIST","ORDER_CREATE"]'::jsonb
    where id = ${fixture.supplierId}
  `.execute(ctx.db);
  await sql`
    insert into supplier_catalog_product
      (id, supplier_id, external_product_id, external_variant_id, upstream_name_vi,
       availability, domain_status, domain_unsupported_reason, supplier_cost_vnd, currency,
       selection_status, is_enabled, is_missing, local_product_id, local_variant_id, supplier_sku_id)
    values
      (${newId()}, ${fixture.supplierId}, ${fixture.externalSku}, '', 'Upstream product',
       'AVAILABLE', 'SUPPORTED', null, 120000, 'VND',
       'SELECTED', true, false, ${fixture.productId}, ${fixture.variantId}, ${fixture.supplierSkuId})
  `.execute(ctx.db);
}

async function setCatalogState(
  fixture: Awaited<ReturnType<typeof seedSupplierPaidOrder>>,
  state: CatalogState,
): Promise<void> {
  await sql`
    update supplier_catalog_product
    set availability = ${state.availability},
        domain_status = ${state.domainStatus},
        domain_unsupported_reason = ${state.reason},
        selection_status = ${state.selectionStatus},
        is_enabled = ${state.enabled},
        is_missing = ${state.missing}
    where supplier_id = ${fixture.supplierId}
      and supplier_sku_id = ${fixture.supplierSkuId}
  `.execute(ctx.db);
}

async function catalogFulfillmentAttempt(
  state?: Partial<CatalogState>,
  includeCatalog = true,
  mutation?: MappingMutation,
): Promise<{
  fixture: Awaited<ReturnType<typeof seedSupplierPaidOrder>>;
  result: Awaited<ReturnType<typeof fulfillPaidOrder>>;
  createCalls: number;
  supplierOrders: number;
  assets: number;
  bundles: number;
}> {
  const fixture = await seedSupplierPaidOrder();
  await sql`
    update supplier
    set provider_capabilities = '["CATALOG_LIST","ORDER_CREATE"]'::jsonb
    where id = ${fixture.supplierId}
  `.execute(ctx.db);
  if (includeCatalog) {
    await makeCatalogManaged(fixture);
    if (state) {
      await setCatalogState(fixture, {
        availability: "AVAILABLE",
        domainStatus: "SUPPORTED",
        selectionStatus: "SELECTED",
        enabled: true,
        missing: false,
        reason: null,
        ...state,
      });
    }
  }
  if (mutation === "SUPPLIER_DISABLED") {
    await sql`update supplier set status = 'DISABLED' where id = ${fixture.supplierId}`.execute(
      ctx.db,
    );
  } else if (mutation === "SKU_DISABLED") {
    await sql`update supplier_sku set is_active = false where id = ${fixture.supplierSkuId}`.execute(
      ctx.db,
    );
  } else if (mutation === "PRIMARY_CLEARED") {
    await sql`update product_variant set supplier_sku_id = null where id = ${fixture.variantId}`.execute(
      ctx.db,
    );
  }
  const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
  let createCalls = 0;
  const supplier = {
    ...sandbox,
    providerKey: fixture.supplierId,
    displayName: "Catalog provider",
    capabilities: new Set(["CATALOG_LIST", "ORDER_CREATE"] as const),
    async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
      createCalls += 1;
      return sandbox.createOrder(input);
    },
  };
  const result = await fulfillPaidOrder(ctx.db, {
    orderId: fixture.orderId,
    correlationId: "catalog-readiness-regression",
    deps: {
      vault: createInMemoryVault(),
      supplier,
      supplierPurchaseEnabled: () => true,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    },
  });
  const counts = await sql<{ supplier_orders: number; assets: number; bundles: number }>`
    select
      (select count(*)::int from supplier_order where order_id = ${fixture.orderId}) as supplier_orders,
      (select count(*)::int from digital_asset where reserved_order_id = ${fixture.orderId}) as assets,
      (select count(*)::int from delivery_bundle where order_id = ${fixture.orderId}) as bundles
  `.execute(ctx.db);
  return {
    fixture,
    result,
    createCalls,
    supplierOrders: counts.rows[0]?.supplier_orders ?? 0,
    assets: counts.rows[0]?.assets ?? 0,
    bundles: counts.rows[0]?.bundles ?? 0,
  };
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

  it.each([
    [
      "UNSUPPORTED",
      {
        domainStatus: "UNSUPPORTED",
        reason: "MAX_QUANTITY_SEMANTICS_UNKNOWN",
        enabled: false,
      },
    ],
    ["OUT", { availability: "OUT", enabled: false }],
    ["MISSING", { availability: "MISSING", enabled: false, missing: true }],
    ["disabled", { enabled: false }],
    ["DISCOVERED", { selectionStatus: "DISCOVERED", enabled: false }],
  ] as const)("blocks a paid order when current catalog mapping is %s", async (_label, state) => {
    const attempt = await catalogFulfillmentAttempt(state);

    expect(attempt.result).toMatchObject({ ok: false, code: "SUPPLIER_UNSUPPORTED" });
    expect(attempt.createCalls).toBe(0);
    expect(attempt.supplierOrders).toBe(0);
    expect(attempt.assets).toBe(0);
    expect(attempt.bundles).toBe(0);
  });
  it.each(["SUPPLIER_DISABLED", "SKU_DISABLED"] as const)(
    "blocks a paid order when the current %s mapping is inactive",
    async (mutation) => {
      const attempt = await catalogFulfillmentAttempt(undefined, true, mutation);

      expect(attempt.result).toMatchObject({ ok: false, code: "SUPPLIER_UNSUPPORTED" });
      expect(attempt.createCalls).toBe(0);
      expect(attempt.supplierOrders).toBe(0);
      expect(attempt.assets).toBe(0);
      expect(attempt.bundles).toBe(0);
    },
  );

  it("blocks a paid order when the current primary mapping is cleared", async () => {
    const attempt = await catalogFulfillmentAttempt(undefined, true, "PRIMARY_CLEARED");

    expect(attempt.result).toMatchObject({ ok: false, code: "NEEDS_REVIEW" });
    expect(attempt.createCalls).toBe(0);
    expect(attempt.supplierOrders).toBe(0);
    expect(attempt.assets).toBe(0);
    expect(attempt.bundles).toBe(0);
  });

  it.each(["AVAILABLE", "LOW"] as const)(
    "allows a paid order for a current catalog mapping that is %s",
    async (availability) => {
      const attempt = await catalogFulfillmentAttempt({ availability });

      expect(attempt.result).toMatchObject({ ok: true, kind: "DELIVERY_BUNDLE" });
      expect(attempt.createCalls).toBe(1);
      expect(attempt.supplierOrders).toBe(1);
      expect(attempt.assets).toBe(1);
      expect(attempt.bundles).toBe(1);
    },
  );

  it("requires a matching catalog row for a catalog-managed provider", async () => {
    const attempt = await catalogFulfillmentAttempt(undefined, false);

    expect(attempt.result).toMatchObject({ ok: false, code: "SUPPLIER_UNSUPPORTED" });
    expect(attempt.createCalls).toBe(0);
    expect(attempt.supplierOrders).toBe(0);
    expect(attempt.assets).toBe(0);
    expect(attempt.bundles).toBe(0);
  });

  it("uses the current explicit primary after an owner primary switch", async () => {
    const first = await seedSupplierPaidOrder();
    await makeCatalogManaged(first);
    const secondSupplierId = newId();
    const secondSkuId = newId();
    const secondExternalSku = `SUP-${newId().slice(-8)}`;
    await sql`
      insert into supplier
        (id, name, adapter_type, credential_vault_ref, status, provider_capabilities)
      values
        (${secondSupplierId}, 'Secondary', 'sandbox', 'vault:sup-cred-2', 'ACTIVE',
         '["CATALOG_LIST","ORDER_CREATE"]'::jsonb)
    `.execute(ctx.db);
    await sql`
      insert into supplier_sku
        (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
      values
        (${secondSkuId}, ${secondSupplierId}, ${first.variantId}, ${secondExternalSku},
         121000, 'VN', 'CREDENTIAL', true)
    `.execute(ctx.db);
    await sql`
      insert into supplier_catalog_product
        (id, supplier_id, external_product_id, external_variant_id, upstream_name_vi,
         availability, domain_status, supplier_cost_vnd, currency, selection_status,
         is_enabled, is_missing, local_product_id, local_variant_id, supplier_sku_id)
      values
        (${newId()}, ${secondSupplierId}, ${secondExternalSku}, '', 'Secondary upstream',
         'AVAILABLE', 'SUPPORTED', 121000, 'VND', 'SELECTED',
         true, false, ${first.productId}, ${first.variantId}, ${secondSkuId})
    `.execute(ctx.db);
    await sql`
      update product_variant set supplier_sku_id = ${secondSkuId} where id = ${first.variantId}
    `.execute(ctx.db);

    const firstBase = createSandboxSupplierAdapter({ mode: "fulfill" });
    const secondBase = createSandboxSupplierAdapter({ mode: "fulfill" });
    let firstCalls = 0;
    let secondCalls = 0;
    const firstProvider = {
      ...firstBase,
      providerKey: first.supplierId,
      displayName: "Primary before switch",
      capabilities: new Set(["CATALOG_LIST", "ORDER_CREATE"] as const),
      async createOrder(input: Parameters<typeof firstBase.createOrder>[0]) {
        firstCalls += 1;
        return firstBase.createOrder(input);
      },
    };
    const secondProvider = {
      ...secondBase,
      providerKey: secondSupplierId,
      displayName: "Current primary",
      capabilities: new Set(["CATALOG_LIST", "ORDER_CREATE"] as const),
      async createOrder(input: Parameters<typeof secondBase.createOrder>[0]) {
        secondCalls += 1;
        return secondBase.createOrder(input);
      },
    };

    const result = await fulfillPaidOrder(ctx.db, {
      orderId: first.orderId,
      correlationId: "primary-switch-regression",
      deps: {
        vault: createInMemoryVault(),
        supplier: null,
        supplierResolver: (supplierId) =>
          supplierId === secondSupplierId
            ? secondProvider
            : supplierId === first.supplierId
              ? firstProvider
              : null,
        supplierPurchaseEnabled: () => true,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      },
    });

    expect(result).toMatchObject({ ok: true, kind: "DELIVERY_BUNDLE" });
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
    const orders = await sql<{ supplier_id: string }>`
      select supplier_id from supplier_order where order_id = ${first.orderId}
    `.execute(ctx.db);
    expect(orders.rows).toEqual([{ supplier_id: secondSupplierId }]);
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
