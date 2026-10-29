import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import {
  provisionFromSupplier,
  recoverUnknownSupplierOrder,
} from "../../src/modules/supplier/service.js";
import {
  SupplierPortError,
  type QueryOrderResult,
  type SupplierPort,
  type SupplierProvider,
} from "../../src/modules/supplier/port.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { performance } from "node:perf_hooks";
import { listActiveCategories } from "../../src/modules/catalog/repository.js";

/**
 * T069 — Supplier create/query with Unknown recovery (FR-015/FR-016).
 *
 * Create is idempotent on the supplier idempotency key. A transport timeout
 * maps to UNKNOWN and is recovered via query (never a silent re-create). A
 * fulfilled envelope is validated before the asset is ingested; a mismatch
 * quarantines the asset (SUPPLIER_NEEDS_REVIEW) rather than delivering it.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  customerId: string;
  variantId: string;
  supplierId: string;
  supplierSkuId: string;
  externalSku: string;
}

async function seedPaidOrderWithSupplierSku(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const supplierId = newId();
  const supplierSkuId = newId();
  const externalSku = "NF-1M-PREMIUM";
  const slug = categoryId.slice(-8);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 199000, 'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      199000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status, provider_capabilities)
    values (${supplierId}, 'Primary', 'sandbox', 'vault:sup-cred', 'ACTIVE',
      '["ORDER_CREATE","DELIVERY_PAYLOAD"]'::jsonb)
  `.execute(ctx.db);
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values (${supplierSkuId}, ${supplierId}, ${variantId}, ${externalSku}, 120000, 'VN', 'CREDENTIAL', true)
  `.execute(ctx.db);
  await sql`
    update product_variant set supplier_sku_id = ${supplierSkuId} where id = ${variantId}
  `.execute(ctx.db);

  return { orderId, customerId, variantId, supplierId, supplierSkuId, externalSku };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, supplier_order, supplier_sku, supplier,
      payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition,
      outbox_event, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function waitForOrderRowLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await sql<{ count: number }>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and lower(coalesce(query, '')) like '%from "order"%'
        and lower(coalesce(query, '')) like '%for update%'
    `.execute(ctx.db);
    if ((waiting.rows[0]?.count ?? 0) >= count) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`expected ${count} supplier calls to wait on the order lock`);
}

async function seedUnknownSupplierOrder(f: Fixture, key: string): Promise<string> {
  const supplierOrderId = newId();
  await sql`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
       external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at)
    values
      (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, ${`idem-${key}`},
       ${`fp-${key}`}, ${`ext-${key}`}, ${`qk-${key}`}, 'UNKNOWN', 150000, 199000,
       49000, now() - interval '10 minutes')
  `.execute(ctx.db);
  return supplierOrderId;
}

async function waitForSupplierReview(supplierOrderId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const review = await sql<{ needs_review_at: string | null }>`
      select needs_review_at from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    if (review.rows[0]?.needs_review_at !== null) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("expected supplier review fence");
}

async function readSupplierReviewState(supplierOrderId: string) {
  const supplierOrder = await sql<{
    status: string;
    needs_review_at: string | null;
    last_error_code: string | null;
  }>`
    select status, needs_review_at, last_error_code
    from supplier_order where id = ${supplierOrderId}
  `.execute(ctx.db);
  const counts = await sql<{ supplier_orders: string; assets: string }>`
    select
      (select count(*)::text from supplier_order where order_id = (select order_id from supplier_order where id = ${supplierOrderId})) as supplier_orders,
      (select count(*)::text from digital_asset where supplier_order_id = ${supplierOrderId}) as assets
  `.execute(ctx.db);
  return {
    supplierOrder: supplierOrder.rows[0],
    supplierOrders: Number(counts.rows[0]?.supplier_orders),
    assets: Number(counts.rows[0]?.assets),
  };
}

async function runLateReviewRace(f: Fixture, key: string, lateResponse: () => QueryOrderResult) {
  const vault = createInMemoryVault();
  const supplierOrderId = await seedUnknownSupplierOrder(f, key);
  const assetVaultRef = await vault.write(`fixture-asset:${key}`, {
    namespace: "asset",
    idempotencyKey: `supplier:${key}:asset`,
  });
  let createCalls = 0;
  let queryCalls = 0;
  let mismatchQueryStarted!: () => void;
  let lateQueryStarted!: () => void;
  let releaseMismatch!: () => void;
  let releaseLate!: () => void;
  const mismatchStarted = new Promise<void>((resolve) => {
    mismatchQueryStarted = resolve;
  });
  const lateStarted = new Promise<void>((resolve) => {
    lateQueryStarted = resolve;
  });
  const mismatchResponse = new Promise<void>((resolve) => {
    releaseMismatch = resolve;
  });
  const lateResponseGate = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const port: SupplierPort & { readonly providerKey: string } = {
    providerKey: f.supplierId,
    getAvailability: () =>
      Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
    createOrder: () => {
      createCalls += 1;
      throw new Error("create must not be called during recovery");
    },
    async queryOrder() {
      queryCalls += 1;
      if (queryCalls === 1) {
        mismatchQueryStarted();
        await mismatchResponse;
        return {
          status: "FULFILLED",
          externalOrderId: `ext-${key}-mismatch`,
          assetEnvelope: {
            deliveryType: "CREDENTIAL",
            expectedSku: f.externalSku,
            region: "VN",
            durationCode: "P1M",
            expiresAt: null,
            supplierAssetId: `${key}-mismatch`,
            fingerprint: `${key}-mismatch-fingerprint`,
            vaultRef: assetVaultRef,
          },
        };
      }
      lateQueryStarted();
      await lateResponseGate;
      return lateResponse();
    },
    cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
    requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
    reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
  };
  const input = {
    supplierOrderId,
    queryKey: `qk-${key}`,
    expectedSku: f.externalSku,
    deliveryType: "CREDENTIAL" as const,
    durationCode: "P1M",
    region: "VN",
    correlationId: `supplier-${key}`,
    port,
    vault,
  };

  const mismatch = recoverUnknownSupplierOrder(ctx.db, input);
  await mismatchStarted;
  const late = recoverUnknownSupplierOrder(ctx.db, input);
  await lateStarted;
  releaseMismatch();
  await waitForSupplierReview(supplierOrderId);
  releaseLate();

  const [mismatchResult, lateResult] = await Promise.all([mismatch, late]);
  return { supplierOrderId, mismatchResult, lateResult, queryCalls, createCalls };
}

it("allows one supplier purchase when concurrent callers use different idempotency keys", async () => {
  const f = await seedPaidOrderWithSupplierSku();
  const vault = createInMemoryVault();
  const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
  let createCalls = 0;
  const port: SupplierPort & { readonly providerKey: string } = {
    ...sandbox,
    providerKey: f.supplierId,
    async createOrder(input) {
      createCalls += 1;
      return { kind: "UNKNOWN", queryKey: input.idempotencyKey, reason: "TIMEOUT" };
    },
  };
  const makeInput = (suffix: string) => ({
    orderId: f.orderId,
    supplierId: f.supplierId,
    supplierSkuId: f.supplierSkuId,
    externalSku: f.externalSku,
    costCeilingVnd: 150000,
    salePriceVnd: 199000,
    expectedSku: f.externalSku,
    deliveryType: "CREDENTIAL",
    durationCode: "P1M",
    region: "VN",
    correlationId: `supplier-concurrent-${suffix}`,
    port,
    vault,
    purchaseEnabled: true,
    idempotencyKey: `${f.orderId}:${suffix}`,
  });

  const owner = await ctx.handle.pool.connect();
  let ownerInTransaction = true;
  await owner.query("begin");
  await owner.query('select id from "order" where id = $1 for update', [f.orderId]);
  const pending = [
    provisionFromSupplier(ctx.db, makeInput("first")),
    provisionFromSupplier(ctx.db, makeInput("second")),
  ];
  try {
    await waitForOrderRowLockWaiters(2);
    await owner.query("commit");
    ownerInTransaction = false;
  } finally {
    if (ownerInTransaction) await owner.query("rollback");
    owner.release();
  }

  const results = await Promise.all(pending);
  expect(results).toEqual([
    expect.objectContaining({ ok: true, kind: "UNKNOWN" }),
    expect.objectContaining({ ok: true, kind: "UNKNOWN" }),
  ]);
  expect(createCalls).toBe(1);
  const persisted = await sql<{
    count: number;
    attempt_count: number;
    cost_vnd_snapshot: number;
    sale_price_vnd_snapshot: number;
    margin_vnd_snapshot: number;
  }>`
      select count(*)::int as count, max(attempt_count)::int as attempt_count,
        max(cost_vnd_snapshot)::int as cost_vnd_snapshot,
        max(sale_price_vnd_snapshot)::int as sale_price_vnd_snapshot,
        max(margin_vnd_snapshot)::int as margin_vnd_snapshot
      from supplier_order
      where order_id = ${f.orderId}
    `.execute(ctx.db);
  expect(persisted.rows[0]).toEqual({
    count: 1,
    attempt_count: 1,
    cost_vnd_snapshot: 120000,
    sale_price_vnd_snapshot: 199000,
    margin_vnd_snapshot: 79000,
  });
});

describe("supplier provision service (FR-015/FR-016)", () => {
  it("keeps catalog reads responsive while supplier create is blocked", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        entered();
        await blocked;
        return sandbox.createOrder(input);
      },
    };
    const pending = provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "slow-isolation",
      port,
      vault,
      purchaseEnabled: true,
    });
    try {
      await started;
      const timings: number[] = [];
      for (let i = 0; i < 100; i++) {
        const before = performance.now();
        expect((await listActiveCategories(ctx.db)).length).toBeGreaterThan(0);
        timings.push(performance.now() - before);
      }
      timings.sort((a, b) => a - b);
      console.warn(
        JSON.stringify({
          probe: "blocked-supplier-catalog",
          reads: 100,
          p50Ms: timings[49],
          p95Ms: timings[94],
          p99Ms: timings[98],
          poolWaiting: ctx.handle.pool.waitingCount,
          production: false,
        }),
      );
    } finally {
      release();
      await pending;
    }
    expect((await pending).ok).toBe(true);
  });

  it("does not call the upstream when the purchase gate is disabled", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "purchase-gate-disabled",
      port,
      vault,
      purchaseEnabled: false,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it.each([
    ["missing", undefined],
    ["mismatched", "different-supplier"],
  ] as const)(
    "rejects a %s provider identity before claiming a supplier attempt",
    async (_label, providerKey) => {
      const f = await seedPaidOrderWithSupplierSku();
      const vault = createInMemoryVault();
      const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
      let createCalls = 0;
      const port = {
        ...sandbox,
        ...(providerKey === undefined ? {} : { providerKey }),
        async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
          createCalls += 1;
          return sandbox.createOrder(input);
        },
      };

      const result = await provisionFromSupplier(ctx.db, {
        orderId: f.orderId,
        supplierId: f.supplierId,
        supplierSkuId: f.supplierSkuId,
        externalSku: f.externalSku,
        costCeilingVnd: 150000,
        salePriceVnd: 199000,
        expectedSku: f.externalSku,
        deliveryType: "CREDENTIAL",
        durationCode: "P1M",
        region: "VN",
        correlationId: `supplier-provider-identity-${_label}`,
        port,
        vault,
        purchaseEnabled: true,
      });

      expect(result).toMatchObject({ ok: false, code: "SUPPLIER_UNAVAILABLE" });
      expect(createCalls).toBe(0);
      const orders = await sql<{ count: number }>`
        select count(*)::int as count from supplier_order where order_id = ${f.orderId}
      `.execute(ctx.db);
      expect(orders.rows[0]?.count).toBe(0);
    },
  );

  it("rejects recovery before query when provider identity mismatches", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const supplierOrderId = await seedUnknownSupplierOrder(f, "provider-identity-mismatch");
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    let queryCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: `${f.supplierId}-different`,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
      async queryOrder(input) {
        queryCalls += 1;
        return sandbox.queryOrder(input);
      },
    };

    const result = await recoverUnknownSupplierOrder(ctx.db, {
      supplierOrderId,
      queryKey: "qk-provider-identity-mismatch",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-provider-identity-mismatch",
      port,
      vault,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect({ createCalls, queryCalls }).toEqual({ createCalls: 0, queryCalls: 0 });
    const row = await sql<{ status: string; needs_review_at: string | null }>`
      select status, needs_review_at from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ status: "UNKNOWN", needs_review_at: null });
  });

  it("fails closed on selected-SKU OUT availability without creating an intent", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "reject", vault });
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-availability-out",
      port,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "SUPPLIER_UNAVAILABLE" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it("fails closed when STOCK_QUANTITY reports zero despite AVAILABLE status", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`
      update supplier
      set provider_capabilities = '["ORDER_CREATE","DELIVERY_PAYLOAD","STOCK_QUANTITY"]'::jsonb
      where id = ${f.supplierId}
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let availabilityCalls = 0;
    let createCalls = 0;
    const provider: SupplierProvider = {
      ...sandbox,
      providerKey: f.supplierId,
      displayName: "Zero stock",
      capabilities: new Set(["ORDER_CREATE", "DELIVERY_PAYLOAD", "STOCK_QUANTITY"]),
      async getAvailability(input) {
        availabilityCalls += 1;
        return {
          status: "AVAILABLE",
          observedAt: new Date().toISOString(),
          quantity: 0,
          ...(input.region ? { supplierReference: input.region } : {}),
        };
      },
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-availability-zero-quantity",
      port: provider,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "SUPPLIER_UNAVAILABLE" });
    expect({ availabilityCalls, createCalls }).toEqual({ availabilityCalls: 1, createCalls: 0 });
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });

  it("fails closed on malformed provider health without creating an intent", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const port = {
      ...sandbox,
      providerKey: f.supplierId,
      displayName: "Malformed health",
      capabilities: new Set(["HEALTH_READ", "ORDER_CREATE", "DELIVERY_PAYLOAD"] as const),
      health: async () => ({ ready: "yes", service: null }),
      async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    } as unknown as SupplierProvider;

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-health-malformed",
      port,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "SUPPLIER_UNAVAILABLE" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it("fails closed when persisted supplier credential configuration is missing", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`
      update supplier
      set credential_vault_ref = ''
      where id = ${f.supplierId}
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };
    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "missing-supplier-credential",
      port,
      vault,
      purchaseEnabled: true,
    });
    expect(result).toMatchObject({ ok: false, code: "SUPPLIER_UNAVAILABLE" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it("does not query or create a cancelled supplier order", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`update "order" set status = 'PROCESSING' where id = ${f.orderId}`.execute(ctx.db);
    const supplierOrderId = newId();
    const idempotencyKey = "idem-cancelled-1";
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, ${idempotencyKey},
         'fp-cancelled', 'CANCELLED', 150000, 199000, 49000, now())
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    let queryCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
      async queryOrder(input) {
        queryCalls += 1;
        return sandbox.queryOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-cancelled",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey,
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_TERMINAL" });
    expect({ createCalls, queryCalls }).toEqual({ createCalls: 0, queryCalls: 0 });
    const assets = await sql<{ count: number }>`
      select count(*)::int as count from digital_asset
    `.execute(ctx.db);
    expect(assets.rows[0]?.count).toBe(0);
  });
  it("treats a REFUND_PENDING order as terminal before supplier create", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`update "order" set status = 'REFUND_PENDING' where id = ${f.orderId}`.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-refund-pending",
      port,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_TERMINAL" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });

  it("reports UNSUPPORTED for an active supplier mapping without ORDER_CREATE", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const provider: SupplierProvider = {
      ...sandbox,
      providerKey: f.supplierId,
      displayName: "Health only",
      capabilities: new Set(["HEALTH_READ"]),
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "missing-order-capability",
      port: provider,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it("reports UNSUPPORTED without DELIVERY_PAYLOAD before creating a supplier order", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`
      update supplier
      set provider_capabilities = '["ORDER_CREATE"]'::jsonb
      where id = ${f.supplierId}
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const provider: SupplierProvider = {
      ...sandbox,
      providerKey: f.supplierId,
      displayName: "Adapter supports delivery but persisted metadata does not",
      capabilities: new Set(["ORDER_CREATE", "ORDER_READ", "DELIVERY_PAYLOAD"]),
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "missing-delivery-payload-capability",
      port: provider,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });

  it("fails closed when adapter and stored supplier capabilities are missing", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    await sql`
      update supplier
      set provider_capabilities = '[]'::jsonb
      where id = ${f.supplierId}
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: (input) => sandbox.getAvailability(input),
      async createOrder(input) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
      queryOrder: (input) => sandbox.queryOrder(input),
      cancelOrder: (input) => sandbox.cancelOrder(input),
      requestRefund: (input) => sandbox.requestRefund(input),
      reconcile: (input) => sandbox.reconcile(input),
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "missing-capability-metadata",
      port,
      vault,
      purchaseEnabled: true,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });

  it("provisions a fulfilled supplier order into a READY local asset", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = {
      ...createSandboxSupplierAdapter({ mode: "fulfill", vault }),
      providerKey: f.supplierId,
    };

    const res = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-1",
      port,
      vault,
      purchaseEnabled: true,
    });
    expect(res).toMatchObject({ ok: true, kind: "FULFILLED" });
    if (!res.ok || res.kind !== "FULFILLED") return;
    expect(res.assetId).toBeTruthy();

    const asset = await sql<{ status: string; source_type: string; vault_ref: string }>`
      select status, source_type, vault_ref from digital_asset where id = ${res.assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]?.status).toBe("READY");
    expect(asset.rows[0]?.source_type).toBe("SUPPLIER");
    expect(asset.rows[0]?.vault_ref.startsWith("vault:")).toBe(true);

    const so = await sql<{
      status: string;
      provider_client_order_id: string | null;
      attempt_count: number;
      response_fingerprint: string | null;
      needs_review_at: string | null;
    }>`
      select status, provider_client_order_id, attempt_count, response_fingerprint, needs_review_at
      from supplier_order where id = ${res.supplierOrderId}
    `.execute(ctx.db);
    expect(so.rows[0]).toMatchObject({
      status: "FULFILLED",
      provider_client_order_id: expect.any(String),
      attempt_count: 1,
      response_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      needs_review_at: null,
    });
  });
  it("quarantines a fulfilled supplier result when vault reveal fails", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const providerVault = createInMemoryVault();
    const port = {
      ...createSandboxSupplierAdapter({ mode: "fulfill", vault: providerVault }),
      providerKey: f.supplierId,
    };
    const serviceVault = createInMemoryVault();
    const unavailableVault = {
      ...serviceVault,
      async reveal(_ref: string): Promise<string> {
        throw new Error("vault unavailable");
      },
    };

    const res = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-vault-failure",
      port,
      vault: unavailableVault,
      purchaseEnabled: true,
    });

    expect(res).toMatchObject({ ok: true, kind: "NEEDS_REVIEW" });
    if (!res.ok || res.kind !== "NEEDS_REVIEW") return;
    const asset = await sql<{
      status: string;
      reserved_order_id: string | null;
      validation_summary: unknown;
    }>`
      select status, reserved_order_id, validation_summary
      from digital_asset where id = ${res.assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]).toMatchObject({
      status: "SUPPLIER_NEEDS_REVIEW",
      reserved_order_id: null,
      validation_summary: { quarantined: true, reasonCode: "VAULT_UNAVAILABLE" },
    });
    const supplierOrder = await sql<{
      status: string;
      needs_review_at: string | null;
      last_error_code: string | null;
    }>`
      select status, needs_review_at, last_error_code
      from supplier_order where id = ${res.supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]).toMatchObject({
      status: "FULFILLED",
      needs_review_at: expect.anything(),
      last_error_code: "VAULT_UNAVAILABLE",
    });
  });

  it("fences an existing asset vault failure on the supplier order", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const providerVault = createInMemoryVault();
    const assetVaultRef = await providerVault.write("fixture-asset:existing-vault-failure", {
      namespace: "asset",
      idempotencyKey: "supplier:existing-vault-failure:asset",
    });
    const supplierOrderId = await seedUnknownSupplierOrder(f, "existing-vault-failure");
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, supplier_order_id, vault_ref, fingerprint_hash,
         status, reserved_order_id)
      values
        (${assetId}, ${f.variantId}, 'SUPPLIER', ${supplierOrderId}, ${assetVaultRef},
         'fp-existing-vault-failure', 'READY', ${f.orderId})
    `.execute(ctx.db);

    const serviceVault = createInMemoryVault();
    const unavailableVault = {
      ...serviceVault,
      async reveal(_ref: string): Promise<string> {
        throw new Error("vault unavailable");
      },
    };
    let createCalls = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        createCalls += 1;
        throw new Error("create must not be called during recovery");
      },
      queryOrder: () =>
        Promise.resolve({
          status: "FULFILLED" as const,
          externalOrderId: "ext-existing-vault-failure",
          assetEnvelope: {
            deliveryType: "CREDENTIAL" as const,
            expectedSku: f.externalSku,
            region: "VN",
            durationCode: "P1M",
            expiresAt: null,
            supplierAssetId: "asset-existing-vault-failure",
            fingerprint: "fp-existing-vault-failure",
            vaultRef: assetVaultRef,
          },
        }),
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };

    const result = await recoverUnknownSupplierOrder(ctx.db, {
      supplierOrderId,
      queryKey: "qk-existing-vault-failure",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-existing-vault-failure",
      port,
      vault: unavailableVault,
    });

    expect(result).toEqual({ ok: true, kind: "NEEDS_REVIEW", assetId });
    expect(createCalls).toBe(0);
    const state = await readSupplierReviewState(supplierOrderId);
    expect(state.supplierOrder).toMatchObject({
      status: "UNKNOWN",
      needs_review_at: expect.anything(),
      last_error_code: "VAULT_UNAVAILABLE",
    });
    expect(state.supplierOrders).toBe(1);
    expect(state.assets).toBe(1);
    const asset = await sql<{
      status: string;
      reserved_order_id: string | null;
    }>`
      select status, reserved_order_id from digital_asset where id = ${assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]).toEqual({
      status: "SUPPLIER_NEEDS_REVIEW",
      reserved_order_id: null,
    });
  });

  it("quarantined fulfillment replays as NEEDS_REVIEW without duplicating assets", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = {
      ...createSandboxSupplierAdapter({ mode: "fulfill", vault }),
      providerKey: f.supplierId,
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: "OTHER-SKU",
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-quarantine",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey: "idem-quarantine-1",
    };

    const first = await provisionFromSupplier(ctx.db, input);
    const second = await provisionFromSupplier(ctx.db, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.kind).toBe("NEEDS_REVIEW");
    const reviewState = await sql<{ needs_review_at: string | null }>`
      select needs_review_at from supplier_order where id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(reviewState.rows[0]?.needs_review_at).not.toBeNull();
    expect(second.kind).toBe("NEEDS_REVIEW");
    if (first.kind !== "NEEDS_REVIEW" || second.kind !== "NEEDS_REVIEW") return;
    expect(second.assetId).toBe(first.assetId);

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);
  });

  it("concurrent recovery dedupes on supplier row lock and creates one asset", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = {
      ...createSandboxSupplierAdapter({ mode: "fulfill", vault }),
      providerKey: f.supplierId,
    };
    const supplierOrderId = newId();
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-recover-lock', 'fp-recover-lock',
         'UNKNOWN', 150000, 199000, 49000, now() - interval '10 minutes')
    `.execute(ctx.db);
    await port.createOrder({
      idempotencyKey: "idem-recover-lock",
      supplierSku: f.externalSku,
      costCeilingVnd: 150000,
      orderId: f.orderId,
      region: "VN",
    });

    const input = {
      supplierOrderId,
      queryKey: "qk-idem-recover-lock",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-recover-lock",
      port,
      vault,
      purchaseEnabled: true,
    };

    const [first, second] = await Promise.all([
      recoverUnknownSupplierOrder(ctx.db, input),
      recoverUnknownSupplierOrder(ctx.db, input),
    ]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.kind).toBe("FULFILLED");
    expect(second.kind).toBe("FULFILLED");
    if (first.kind !== "FULFILLED" || second.kind !== "FULFILLED") return;
    expect(second.assetId).toBe(first.assetId);

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);
  });
  it("preserves a review fence when mismatched and valid fulfillments race", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    const assetVaultRef = await vault.write("fixture-asset:review-race", {
      namespace: "asset",
      idempotencyKey: "supplier:review-race:asset",
    });
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
         margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-review-race',
         'fp-review-race', 'ext-review-race', 'qk-review-race', 'UNKNOWN', 150000, 199000,
         49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let queryCalls = 0;
    let mismatchQueryStarted!: () => void;
    let validQueryStarted!: () => void;
    let releaseMismatch!: () => void;
    let releaseValid!: () => void;
    const mismatchStarted = new Promise<void>((resolve) => {
      mismatchQueryStarted = resolve;
    });
    const validStarted = new Promise<void>((resolve) => {
      validQueryStarted = resolve;
    });
    const validResponse = new Promise<void>((resolve) => {
      releaseValid = resolve;
    });
    const mismatchResponse = new Promise<void>((resolve) => {
      releaseMismatch = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        throw new Error("create must not be called during recovery");
      },
      async queryOrder() {
        queryCalls += 1;
        if (queryCalls === 1) {
          mismatchQueryStarted();
          await mismatchResponse;
          return {
            status: "FULFILLED",
            externalOrderId: "ext-review-mismatch",
            assetEnvelope: {
              deliveryType: "CREDENTIAL",
              expectedSku: f.externalSku,
              region: "VN",
              durationCode: "P1M",
              expiresAt: null,
              supplierAssetId: "asset-review-mismatch",
              fingerprint: "fp-review-mismatch",
              vaultRef: assetVaultRef,
            },
          };
        }
        validQueryStarted();
        await validResponse;
        return {
          status: "FULFILLED",
          externalOrderId: "ext-review-race",
          assetEnvelope: {
            deliveryType: "CREDENTIAL",
            expectedSku: f.externalSku,
            region: "VN",
            durationCode: "P1M",
            expiresAt: null,
            supplierAssetId: "asset-review-valid",
            fingerprint: "fp-review-valid",
            vaultRef: assetVaultRef,
          },
        };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-review-race",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-review-race",
      port,
      vault,
    };

    const mismatched = recoverUnknownSupplierOrder(ctx.db, input);
    await mismatchStarted;
    const valid = recoverUnknownSupplierOrder(ctx.db, input);
    await validStarted;
    releaseMismatch();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const review = await sql<{ needs_review_at: string | null }>`
        select needs_review_at from supplier_order where id = ${supplierOrderId}
      `.execute(ctx.db);
      if (review.rows[0]?.needs_review_at !== null) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseValid();

    const [mismatchedResult, validResult] = await Promise.all([mismatched, valid]);
    expect(mismatchedResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(validResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(queryCalls).toBe(2);

    const supplierOrder = await sql<{ status: string; needs_review_at: string | null }>`
      select status, needs_review_at from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]?.status).toBe("UNKNOWN");
    expect(supplierOrder.rows[0]?.needs_review_at).not.toBeNull();
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(0);
  });
  it("returns NEEDS_REVIEW for a late REJECTED response after the review fence", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const race = await runLateReviewRace(f, "late-rejected", () => ({
      status: "REJECTED",
      externalOrderId: "ext-late-rejected",
    }));

    expect(race.mismatchResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.lateResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.queryCalls).toBe(2);
    expect(race.createCalls).toBe(0);
    const state = await readSupplierReviewState(race.supplierOrderId);
    expect(state.supplierOrder).toMatchObject({
      status: "UNKNOWN",
      last_error_code: "IDENTITY_MISMATCH",
    });
    expect(state.supplierOrder?.needs_review_at).not.toBeNull();
    expect(state.supplierOrders).toBe(1);
    expect(state.assets).toBe(0);
  });

  it("returns NEEDS_REVIEW for a late UNKNOWN response after the review fence", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const race = await runLateReviewRace(f, "late-unknown", () => {
      throw new SupplierPortError("SCHEMA_INVALID", "late unknown response");
    });

    expect(race.mismatchResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.lateResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.queryCalls).toBe(2);
    expect(race.createCalls).toBe(0);
    const state = await readSupplierReviewState(race.supplierOrderId);
    expect(state.supplierOrder).toMatchObject({
      status: "UNKNOWN",
      last_error_code: "IDENTITY_MISMATCH",
    });
    expect(state.supplierOrder?.needs_review_at).not.toBeNull();
    expect(state.supplierOrders).toBe(1);
    expect(state.assets).toBe(0);
  });

  it("returns NEEDS_REVIEW for a late transport failure after the review fence", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const race = await runLateReviewRace(f, "late-transport", () => {
      throw new SupplierPortError("TRANSPORT_ERROR", "late transport failure");
    });

    expect(race.mismatchResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.lateResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(race.queryCalls).toBe(2);
    expect(race.createCalls).toBe(0);
    const state = await readSupplierReviewState(race.supplierOrderId);
    expect(state.supplierOrder).toMatchObject({
      status: "UNKNOWN",
      last_error_code: "IDENTITY_MISMATCH",
    });
    expect(state.supplierOrder?.needs_review_at).not.toBeNull();
    expect(state.supplierOrders).toBe(1);
    expect(state.assets).toBe(0);
  });

  it("preserves the first reason across two distinct concurrent review findings", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const supplierOrderId = await seedUnknownSupplierOrder(f, "review-reasons");
    let queryCalls = 0;
    let firstQueryStarted!: () => void;
    let secondQueryStarted!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstQueryStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondQueryStarted = resolve;
    });
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondResponse = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        throw new Error("create must not be called during recovery");
      },
      async queryOrder() {
        queryCalls += 1;
        if (queryCalls === 1) {
          firstQueryStarted();
          await firstResponse;
          throw new SupplierPortError("DELIVERY_UNSUPPORTED", "first review finding");
        }
        secondQueryStarted();
        await secondResponse;
        throw new SupplierPortError("IDENTITY_MISMATCH", "second review finding");
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-review-reasons",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-review-reasons",
      port,
      vault: createInMemoryVault(),
    };

    const first = recoverUnknownSupplierOrder(ctx.db, input);
    await firstStarted;
    const second = recoverUnknownSupplierOrder(ctx.db, input);
    await secondStarted;
    releaseFirst();
    await waitForSupplierReview(supplierOrderId);
    releaseSecond();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(secondResult).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(queryCalls).toBe(2);
    const state = await readSupplierReviewState(supplierOrderId);
    expect(state.supplierOrder).toMatchObject({
      status: "UNKNOWN",
      needs_review_at: expect.anything(),
      last_error_code: "DELIVERY_UNSUPPORTED",
    });
    expect(state.supplierOrders).toBe(1);
    expect(state.assets).toBe(0);
  });

  it("does not let a late pending response overwrite supplier review state", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    const assetVaultRef = await vault.write("fixture-asset:review-pending-race", {
      namespace: "asset",
      idempotencyKey: "supplier:review-pending-race:asset",
    });
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
         margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-review-pending',
         'fp-review-pending', 'ext-review-pending', 'qk-review-pending', 'UNKNOWN', 150000, 199000,
         49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let queryCalls = 0;
    let mismatchQueryStarted!: () => void;
    let pendingQueryStarted!: () => void;
    let releaseMismatch!: () => void;
    let releasePending!: () => void;
    const mismatchStarted = new Promise<void>((resolve) => {
      mismatchQueryStarted = resolve;
    });
    const pendingStarted = new Promise<void>((resolve) => {
      pendingQueryStarted = resolve;
    });
    const mismatchResponse = new Promise<void>((resolve) => {
      releaseMismatch = resolve;
    });
    const pendingResponse = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        throw new Error("create must not be called during recovery");
      },
      async queryOrder() {
        queryCalls += 1;
        if (queryCalls === 1) {
          mismatchQueryStarted();
          await mismatchResponse;
          return {
            status: "FULFILLED",
            externalOrderId: "ext-review-mismatch",
            assetEnvelope: {
              deliveryType: "CREDENTIAL",
              expectedSku: f.externalSku,
              region: "VN",
              durationCode: "P1M",
              expiresAt: null,
              supplierAssetId: "asset-review-mismatch",
              fingerprint: "fp-review-mismatch",
              vaultRef: assetVaultRef,
            },
          };
        }
        pendingQueryStarted();
        await pendingResponse;
        return { status: "PENDING", externalOrderId: "ext-review-pending" };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-review-pending",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-review-pending-race",
      port,
      vault,
    };

    const mismatch = recoverUnknownSupplierOrder(ctx.db, input);
    await mismatchStarted;
    const pending = recoverUnknownSupplierOrder(ctx.db, input);
    await pendingStarted;
    releaseMismatch();
    let reviewRecorded = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const review = await sql<{ needs_review_at: string | null }>`
        select needs_review_at from supplier_order where id = ${supplierOrderId}
      `.execute(ctx.db);
      if (review.rows[0]?.needs_review_at !== null) {
        reviewRecorded = true;
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(reviewRecorded).toBe(true);
    releasePending();

    const [mismatchResult, pendingResult] = await Promise.all([mismatch, pending]);
    expect(mismatchResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(pendingResult).toEqual({ ok: true, kind: "NEEDS_REVIEW" });
    expect(queryCalls).toBe(2);

    const supplierOrder = await sql<{
      status: string;
      needs_review_at: string | null;
      last_error_code: string | null;
    }>`
      select status, needs_review_at, last_error_code
      from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]?.status).toBe("UNKNOWN");
    expect(supplierOrder.rows[0]?.needs_review_at).not.toBeNull();
    expect(supplierOrder.rows[0]?.last_error_code).toBe("IDENTITY_MISMATCH");
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(0);
  });

  it("quarantines an existing asset when a later identity mismatch races after fulfillment", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    const assetVaultRef = await vault.write("fixture-asset:review-valid-first", {
      namespace: "asset",
      idempotencyKey: "supplier:review-valid-first:asset",
    });
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
         margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-review-valid-first',
         'fp-review-valid-first', 'ext-review-valid-first', 'qk-review-valid-first', 'UNKNOWN',
         150000, 199000, 49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let queryCalls = 0;
    let validQueryStarted!: () => void;
    let mismatchQueryStarted!: () => void;
    let releaseValid!: () => void;
    let releaseMismatch!: () => void;
    const validStarted = new Promise<void>((resolve) => {
      validQueryStarted = resolve;
    });
    const mismatchStarted = new Promise<void>((resolve) => {
      mismatchQueryStarted = resolve;
    });
    const validResponse = new Promise<void>((resolve) => {
      releaseValid = resolve;
    });
    const mismatchResponse = new Promise<void>((resolve) => {
      releaseMismatch = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        throw new Error("create must not be called during recovery");
      },
      async queryOrder() {
        queryCalls += 1;
        if (queryCalls === 1) {
          validQueryStarted();
          await validResponse;
          return {
            status: "FULFILLED",
            externalOrderId: "ext-review-valid-first",
            assetEnvelope: {
              deliveryType: "CREDENTIAL",
              expectedSku: f.externalSku,
              region: "VN",
              durationCode: "P1M",
              expiresAt: null,
              supplierAssetId: "asset-review-valid-first",
              fingerprint: "fp-review-valid-first",
              vaultRef: assetVaultRef,
            },
          };
        }
        mismatchQueryStarted();
        await mismatchResponse;
        return {
          status: "FULFILLED",
          externalOrderId: "ext-review-mismatch-after",
          assetEnvelope: {
            deliveryType: "CREDENTIAL",
            expectedSku: f.externalSku,
            region: "VN",
            durationCode: "P1M",
            expiresAt: null,
            supplierAssetId: "asset-review-mismatch-after",
            fingerprint: "fp-review-mismatch-after",
            vaultRef: assetVaultRef,
          },
        };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-review-valid-first",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-review-valid-first",
      port,
      vault,
    };

    const valid = recoverUnknownSupplierOrder(ctx.db, input);
    await validStarted;
    const mismatched = recoverUnknownSupplierOrder(ctx.db, input);
    await mismatchStarted;
    releaseValid();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await sql<{ status: string; asset_status: string | null }>`
        select so.status, da.status as asset_status
        from supplier_order so
        left join digital_asset da on da.supplier_order_id = so.id
        where so.id = ${supplierOrderId}
      `.execute(ctx.db);
      if (state.rows[0]?.status === "FULFILLED" && state.rows[0]?.asset_status === "READY") break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const validResult = await valid;
    releaseMismatch();
    const mismatchedResult = await mismatched;
    expect(validResult).toMatchObject({ ok: true, kind: "FULFILLED", assetId: expect.any(String) });
    expect(mismatchedResult).toMatchObject({
      ok: true,
      kind: "NEEDS_REVIEW",
      assetId: expect.any(String),
    });
    expect(queryCalls).toBe(2);

    const supplierOrder = await sql<{ status: string; needs_review_at: string | null }>`
      select status, needs_review_at from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]?.status).toBe("FULFILLED");
    expect(supplierOrder.rows[0]?.needs_review_at).not.toBeNull();
    const asset = await sql<{
      status: string;
      reserved_order_id: string | null;
      delivered_order_id: string | null;
    }>`
      select status, reserved_order_id, delivered_order_id
      from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(asset.rows[0]).toEqual({
      status: "SUPPLIER_NEEDS_REVIEW",
      reserved_order_id: null,
      delivered_order_id: null,
    });
  });

  it("quarantines an existing READY asset when a late same-identity invalid fulfillment arrives", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    const assetVaultRef = await vault.write("fixture-asset:review-same-identity-invalid", {
      namespace: "asset",
      idempotencyKey: "supplier:review-same-identity-invalid:asset",
    });
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
         margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId},
         'idem-review-same-identity-invalid', 'fp-review-same-identity-invalid',
         'ext-review-same-identity-invalid', 'qk-review-same-identity-invalid', 'UNKNOWN',
         150000, 199000, 49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let queryCalls = 0;
    let validQueryStarted!: () => void;
    let invalidQueryStarted!: () => void;
    let releaseValid!: () => void;
    let releaseInvalid!: () => void;
    const validStarted = new Promise<void>((resolve) => {
      validQueryStarted = resolve;
    });
    const invalidStarted = new Promise<void>((resolve) => {
      invalidQueryStarted = resolve;
    });
    const validResponse = new Promise<void>((resolve) => {
      releaseValid = resolve;
    });
    const invalidResponse = new Promise<void>((resolve) => {
      releaseInvalid = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        throw new Error("create must not be called during recovery");
      },
      async queryOrder() {
        queryCalls += 1;
        if (queryCalls === 1) {
          validQueryStarted();
          await validResponse;
          return {
            status: "FULFILLED",
            externalOrderId: "ext-review-same-identity-invalid",
            assetEnvelope: {
              deliveryType: "CREDENTIAL",
              expectedSku: f.externalSku,
              region: "VN",
              durationCode: "P1M",
              expiresAt: null,
              supplierAssetId: "asset-review-same-identity-valid",
              fingerprint: "fp-asset-review-same-identity-valid",
              vaultRef: assetVaultRef,
            },
          };
        }
        invalidQueryStarted();
        await invalidResponse;
        return {
          status: "FULFILLED",
          externalOrderId: "ext-review-same-identity-invalid",
          assetEnvelope: {
            deliveryType: "LICENSE",
            expectedSku: "WRONG-SKU",
            region: "VN",
            durationCode: "P12M",
            expiresAt: null,
            supplierAssetId: "asset-review-same-identity-invalid",
            fingerprint: "fp-asset-review-same-identity-invalid",
            vaultRef: assetVaultRef,
          },
        };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-review-same-identity-invalid",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-review-same-identity-invalid",
      port,
      vault,
    };

    const valid = recoverUnknownSupplierOrder(ctx.db, input);
    await validStarted;
    const invalid = recoverUnknownSupplierOrder(ctx.db, input);
    await invalidStarted;
    releaseValid();
    const validResult = await valid;
    releaseInvalid();
    const invalidResult = await invalid;

    expect(validResult).toMatchObject({
      ok: true,
      kind: "FULFILLED",
      assetId: expect.any(String),
    });
    expect(invalidResult).toMatchObject({
      ok: true,
      kind: "NEEDS_REVIEW",
      assetId: expect.any(String),
    });
    if (
      !validResult.ok ||
      validResult.kind !== "FULFILLED" ||
      !invalidResult.ok ||
      invalidResult.kind !== "NEEDS_REVIEW"
    )
      return;
    expect(invalidResult.assetId).toBe(validResult.assetId);
    expect(queryCalls).toBe(2);

    const supplierOrder = await sql<{
      status: string;
      external_order_id: string | null;
      needs_review_at: string | null;
      last_error_code: string | null;
    }>`
      select status, external_order_id, needs_review_at, last_error_code
      from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]).toMatchObject({
      status: "FULFILLED",
      external_order_id: "ext-review-same-identity-invalid",
      needs_review_at: expect.anything(),
      last_error_code: "SKU_MISMATCH",
    });

    const asset = await sql<{
      status: string;
      reserved_order_id: string | null;
      reserved_until: string | null;
      delivered_order_id: string | null;
      validation_summary: unknown;
    }>`
      select status, reserved_order_id, reserved_until, delivered_order_id, validation_summary
      from digital_asset where id = ${validResult.assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]).toEqual({
      status: "SUPPLIER_NEEDS_REVIEW",
      reserved_order_id: null,
      reserved_until: null,
      delivered_order_id: null,
      validation_summary: { quarantined: true, reasonCode: "SKU_MISMATCH" },
    });

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);
  });

  it("does not ingest a stale fulfilled recovery after rejection wins", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-recover-race',
         'fp-recover-race', 'UNKNOWN', 150000, 199000, 49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let createCalls = 0;
    let queryCalls = 0;
    let queryStarted!: () => void;
    let releaseFulfilled!: () => void;
    const firstQueryStarted = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const delayedFulfilled = new Promise<void>((resolve) => {
      releaseFulfilled = resolve;
    });
    const assetVaultRef = await vault.write("fixture-asset:recover-race", {
      namespace: "asset",
      idempotencyKey: "supplier:recover-race:asset",
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        createCalls += 1;
        throw new Error("create must not be called during recovery");
      },
      queryOrder: async () => {
        queryCalls += 1;
        if (queryCalls === 1) {
          queryStarted();
          await delayedFulfilled;
          return {
            status: "FULFILLED",
            externalOrderId: "ext-recover-race-fulfilled",
            assetEnvelope: {
              deliveryType: "CREDENTIAL",
              expectedSku: f.externalSku,
              region: "VN",
              durationCode: "P1M",
              expiresAt: null,
              supplierAssetId: "asset-recover-race",
              fingerprint: "fp-asset-recover-race",
              vaultRef: assetVaultRef,
            },
          };
        }
        return {
          status: "REJECTED",
          externalOrderId: "ext-recover-race-rejected",
        };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-recover-race",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-recover-race",
      port,
      vault,
    };

    const fulfilledRecovery = recoverUnknownSupplierOrder(ctx.db, input);
    await firstQueryStarted;
    const rejectedResult = await recoverUnknownSupplierOrder(ctx.db, input);

    expect(rejectedResult).toEqual({ ok: true, kind: "REJECTED" });
    const rejectedRow = await sql<{ status: string }>`
      select status from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(rejectedRow.rows[0]?.status).toBe("REJECTED");

    releaseFulfilled();
    const fulfilledResult = await fulfilledRecovery;

    expect(fulfilledResult).toEqual({ ok: true, kind: "REJECTED" });
    const finalRow = await sql<{ status: string }>`
      select status from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(finalRow.rows[0]?.status).toBe("REJECTED");
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(0);
    expect(createCalls).toBe(0);
  });

  it("returns durable fulfillment when a stale rejection arrives second", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const supplierOrderId = newId();
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, 'idem-fulfill-wins',
         'fp-fulfill-wins', 'UNKNOWN', 150000, 199000, 49000, now() - interval '10 minutes')
    `.execute(ctx.db);

    let createCalls = 0;
    let queryCalls = 0;
    let queryStarted!: () => void;
    let releaseRejection!: () => void;
    const firstQueryStarted = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const delayedRejection = new Promise<void>((resolve) => {
      releaseRejection = resolve;
    });
    const assetVaultRef = await vault.write("fixture-asset:fulfill-wins", {
      namespace: "asset",
      idempotencyKey: "supplier:fulfill-wins:asset",
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "UNKNOWN", observedAt: "2026-01-01T00:00:00.000Z" }),
      createOrder: () => {
        createCalls += 1;
        throw new Error("create must not be called during recovery");
      },
      queryOrder: async () => {
        queryCalls += 1;
        if (queryCalls === 1) {
          queryStarted();
          await delayedRejection;
          return { status: "REJECTED", externalOrderId: "ext-fulfill-wins-rejected" };
        }
        return {
          status: "FULFILLED",
          externalOrderId: "ext-fulfill-wins",
          assetEnvelope: {
            deliveryType: "CREDENTIAL",
            expectedSku: f.externalSku,
            region: "VN",
            durationCode: "P1M",
            expiresAt: null,
            supplierAssetId: "asset-fulfill-wins",
            fingerprint: "fp-asset-fulfill-wins",
            vaultRef: assetVaultRef,
          },
        };
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      supplierOrderId,
      queryKey: "qk-fulfill-wins",
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-fulfill-wins",
      port,
      vault,
    };

    const staleRejection = recoverUnknownSupplierOrder(ctx.db, input);
    await firstQueryStarted;
    const fulfillment = await recoverUnknownSupplierOrder(ctx.db, input);
    expect(fulfillment).toMatchObject({ ok: true, kind: "FULFILLED" });

    releaseRejection();
    expect(await staleRejection).toEqual(fulfillment);

    const finalRow = await sql<{ status: string }>`
      select status from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where supplier_order_id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(finalRow.rows[0]?.status).toBe("FULFILLED");
    expect(Number(assets.rows[0]?.count)).toBe(1);
    expect({ createCalls, queryCalls }).toEqual({ createCalls: 0, queryCalls: 2 });
  });

  it("create is idempotent on the same idempotency key (one supplier_order)", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = {
      ...createSandboxSupplierAdapter({ mode: "fulfill", vault }),
      providerKey: f.supplierId,
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-1",
      port,
      vault,
      purchaseEnabled: true,
      // Stable key so both calls hit the same idempotency slot.
      idempotencyKey: "idem-stable-1",
    };
    const a = await provisionFromSupplier(ctx.db, input);
    const b = await provisionFromSupplier(ctx.db, input);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok && a.kind === "FULFILLED" && b.kind === "FULFILLED") {
      expect(b.assetId).toBe(a.assetId);
      expect(b.supplierOrderId).toBe(a.supplierOrderId);
    }
    const count = await sql<{ count: string }>`
      select count(*)::text as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("does not replay a supplier-order key for a different supplier SKU", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const alternateSkuId = newId();
    await sql`
      insert into supplier_sku
        (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
      values
        (${alternateSkuId}, ${f.supplierId}, ${f.variantId}, 'OTHER-SKU', 120000, 'VN',
         'CREDENTIAL', true)
    `.execute(ctx.db);
    const vault = createInMemoryVault();
    const upstream = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let creates = 0;
    let queries = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      ...upstream,
      providerKey: f.supplierId,
      createOrder(input) {
        creates += 1;
        return upstream.createOrder(input);
      },
      queryOrder(input) {
        queries += 1;
        return upstream.queryOrder(input);
      },
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-idempotency-binding",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey: "idem-bound-to-sku",
    };

    const first = await provisionFromSupplier(ctx.db, input);
    if (!first.ok || first.kind !== "FULFILLED") {
      throw new Error("initial supplier purchase did not fulfill");
    }
    const replay = await provisionFromSupplier(ctx.db, {
      ...input,
      supplierSkuId: alternateSkuId,
      externalSku: "OTHER-SKU",
      expectedSku: "OTHER-SKU",
    });

    expect(replay).toMatchObject({ ok: false, code: "ORDER_TERMINAL" });
    const record = await sql<{ status: string; supplier_sku_id: string }>`
      select status, supplier_sku_id from supplier_order where id = ${first.supplierOrderId}
    `.execute(ctx.db);
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset
      where supplier_order_id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(record.rows[0]).toEqual({ status: "FULFILLED", supplier_sku_id: f.supplierSkuId });
    expect(Number(assets.rows[0]?.count)).toBe(1);
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });
  });

  it("timeout retry queries existing UNKNOWN and never creates again", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const upstream = createSandboxSupplierAdapter({ mode: "timeout-then-fulfill", vault });
    let creates = 0;
    let queries = 0;
    let createSku: string | undefined;
    let recoveredSku: string | undefined;
    const queryInputs: Array<Parameters<SupplierPort["queryOrder"]>[0]> = [];
    const port: SupplierPort & { readonly providerKey: string } = {
      ...upstream,
      providerKey: f.supplierId,
      createOrder(input) {
        creates += 1;
        createSku = input.supplierSku;
        return upstream.createOrder(input);
      },
      queryOrder(input) {
        queries += 1;
        queryInputs.push(input);
        return upstream.queryOrder(input).then((result) => {
          if (result.status === "FULFILLED") recoveredSku = result.assetEnvelope.expectedSku;
          return result;
        });
      },
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-to",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey: "idem-timeout-1",
    };

    const first = await provisionFromSupplier(ctx.db, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.kind).toBe("UNKNOWN");
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });

    const second = await provisionFromSupplier(ctx.db, input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(queryInputs).toEqual([{ queryKey: "qk-idem-timeout-1", expectedSku: f.externalSku }]);
    expect({ createSku, recoveredSku }).toEqual({
      createSku: f.externalSku,
      recoveredSku: f.externalSku,
    });
    const asset = await sql<{ validation_summary: unknown }>`
      select validation_summary from digital_asset
      where supplier_order_id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(asset.rows[0]?.validation_summary).toEqual({ validated: true });
    expect(second.kind).toBe("FULFILLED");
    expect({ creates, queries }).toEqual({ creates: 1, queries: 1 });

    const count = await sql<{ count: string }>`
      select count(*)::text as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("ambiguous accepted retry queries existing PENDING and never creates again", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    let creates = 0;
    let queries = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder: () => {
        creates += 1;
        return Promise.resolve({
          kind: "ACCEPTED",
          externalOrderId: "ext-pending-1",
          status: "PENDING",
        });
      },
      queryOrder: () => {
        queries += 1;
        return Promise.resolve({ status: "PENDING", externalOrderId: "ext-pending-1" });
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-pending",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey: "idem-pending-1",
    };

    const first = await provisionFromSupplier(ctx.db, input);
    const second = await provisionFromSupplier(ctx.db, input);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.kind).toBe("UNKNOWN");
    expect(second.kind).toBe("UNKNOWN");
    expect({ creates, queries }).toEqual({ creates: 1, queries: 1 });
  });
  it("does not query a fresh SUBMITTED record while its original create is delayed", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill", vault });
    let createCalls = 0;
    let queryCalls = 0;
    let createStarted!: () => void;
    let releaseCreate!: () => void;
    const createHasStarted = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const port: SupplierPort & { readonly providerKey: string } = {
      ...sandbox,
      providerKey: f.supplierId,
      async createOrder(input) {
        createCalls += 1;
        createStarted();
        await createRelease;
        return sandbox.createOrder(input);
      },
      async queryOrder(input) {
        queryCalls += 1;
        return sandbox.queryOrder(input);
      },
    };
    const input = {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL" as const,
      durationCode: "P1M",
      region: "VN",
      correlationId: "supplier-submitted-grace",
      port,
      vault,
      purchaseEnabled: true,
      idempotencyKey: "idem-submitted-grace",
    };

    const originalCreate = provisionFromSupplier(ctx.db, input);
    await createHasStarted;
    const earlyQuery = await provisionFromSupplier(ctx.db, input);
    expect(earlyQuery).toMatchObject({
      ok: true,
      kind: "UNKNOWN",
      queryKey: input.idempotencyKey,
    });
    expect({ createCalls, queryCalls }).toEqual({ createCalls: 1, queryCalls: 0 });
    const earlyRow = await sql<{ status: string; needs_review_at: string | null }>`
      select status, needs_review_at from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(earlyRow.rows[0]).toMatchObject({ status: "SUBMITTED", needs_review_at: null });

    releaseCreate();
    const fulfilled = await originalCreate;
    expect(fulfilled).toMatchObject({ ok: true, kind: "FULFILLED" });
    expect({ createCalls, queryCalls }).toEqual({ createCalls: 1, queryCalls: 0 });
  });

  it("recovers a SUBMITTED idempotency record through query-only execution", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const idempotencyKey = "idem-submitted-1";
    const supplierOrderId = newId();
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, ${idempotencyKey}, 'fp-submitted',
         'SUBMITTED', 150000, 199000, 49000, now() - interval '2 minutes')
    `.execute(ctx.db);
    let queries = 0;
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder: () => {
        throw new Error("create must not be called while recovering SUBMITTED");
      },
      queryOrder: ({ queryKey, externalOrderId, expectedSku }) => {
        queries += 1;
        expect({ queryKey, externalOrderId, expectedSku }).toEqual({
          queryKey: idempotencyKey,
          externalOrderId: undefined,
          expectedSku: f.externalSku,
        });
        return Promise.resolve({ status: "PENDING", externalOrderId: "ext-submitted-1" });
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-submitted",
      port,
      vault,
      purchaseEnabled: false,
      idempotencyKey,
    });
    expect(result).toEqual({
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId,
      queryKey: idempotencyKey,
    });
    expect(queries).toBe(1);
  });
  it("recovers a legacy UNKNOWN record using its persisted provider lookup key", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const idempotencyKey = "idem-legacy-unknown-1";
    const legacyKey = `qk-${idempotencyKey}`;
    const supplierOrderId = newId();
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         external_order_id, query_key, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
         margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${f.supplierId}, ${f.supplierSkuId}, ${f.orderId}, ${idempotencyKey}, 'fp-legacy-unknown',
         ${legacyKey}, null, 'UNKNOWN', 150000, 199000, 49000, now())
    `.execute(ctx.db);
    let creates = 0;
    const providerExternalOrderId = "ext-legacy-pending-1";
    const port: SupplierPort & { readonly providerKey: string } = {
      providerKey: f.supplierId,
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder: () => {
        creates += 1;
        return Promise.resolve({
          kind: "ACCEPTED",
          externalOrderId: "ext-unexpected-create",
          status: "PENDING",
        });
      },
      queryOrder: ({ queryKey, externalOrderId, expectedSku }) => {
        expect({ queryKey, externalOrderId, expectedSku }).toEqual({
          queryKey: legacyKey,
          externalOrderId: undefined,
          expectedSku: f.externalSku,
        });
        return Promise.resolve({ status: "PENDING", externalOrderId: providerExternalOrderId });
      },
      cancelOrder: () => Promise.resolve({ status: "UNSUPPORTED" }),
      requestRefund: () => Promise.resolve({ status: "UNSUPPORTED" }),
      reconcile: () => Promise.resolve({ observations: [], nextCursor: null }),
    };

    const result = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-legacy-unknown",
      port,
      vault,
      purchaseEnabled: false,
      idempotencyKey,
    });
    expect(result).toEqual({
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId,
      queryKey: legacyKey,
    });
    expect(creates).toBe(0);

    const row = await sql<{ status: string; external_order_id: string | null }>`
      select status, external_order_id from supplier_order where id = ${supplierOrderId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({
      status: "PENDING",
      external_order_id: providerExternalOrderId,
    });
  });

  it("a rejected supplier response does not create an asset", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port: SupplierPort & { readonly providerKey: string } = {
      ...createSandboxSupplierAdapter({ mode: "reject", vault }),
      providerKey: f.supplierId,
      getAvailability: async () => ({
        status: "AVAILABLE" as const,
        observedAt: new Date().toISOString(),
      }),
    };
    const res = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: f.externalSku,
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-rej",
      port,
      vault,
      purchaseEnabled: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("REJECTED");

    if (res.kind !== "REJECTED") return;

    const supplierOrder = await sql<{ status: string }>`
      select status from supplier_order where id = ${res.supplierOrderId}
    `.execute(ctx.db);
    expect(supplierOrder.rows[0]?.status).toBe("REJECTED");
    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset
      where supplier_order_id = ${res.supplierOrderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(0);
  });
});
