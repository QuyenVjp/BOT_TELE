import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import {
  provisionFromSupplier,
  recoverUnknownSupplierOrder,
} from "../../src/modules/supplier/service.js";
import type { SupplierPort, SupplierProvider } from "../../src/modules/supplier/port.js";
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
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values (${supplierId}, 'Primary', 'sandbox', 'vault:sup-cred', 'ACTIVE')
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

describe("supplier provision service (FR-015/FR-016)", () => {
  it("keeps catalog reads responsive while supplier create is blocked", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: SupplierPort = {
      ...sandbox,
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
      vault: createInMemoryVault(),
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
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
    let createCalls = 0;
    const port: SupplierPort = {
      ...sandbox,
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
      vault: createInMemoryVault(),
      purchaseEnabled: false,
    });

    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(createCalls).toBe(0);
    const orders = await sql<{ count: number }>`
      select count(*)::int as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe(0);
  });
  it("does not call the upstream when the provider lacks ORDER_CREATE", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
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
      vault: createInMemoryVault(),
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
    const port = createSandboxSupplierAdapter({ mode: "fulfill" });

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
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("FULFILLED");
    if (res.kind !== "FULFILLED") return;
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
  it("quarantined fulfillment replays as NEEDS_REVIEW without duplicating assets", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = createSandboxSupplierAdapter({ mode: "fulfill" });
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
    const port = createSandboxSupplierAdapter({ mode: "fulfill" });
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

  it("create is idempotent on the same idempotency key (one supplier_order)", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = createSandboxSupplierAdapter({ mode: "fulfill" });
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

  it("timeout retry queries existing UNKNOWN and never creates again", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const upstream = createSandboxSupplierAdapter({ mode: "timeout-then-fulfill" });
    let creates = 0;
    let queries = 0;
    const port: SupplierPort = {
      ...upstream,
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
    const port: SupplierPort = {
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

  it("in-flight SUBMITTED idempotency loser does not create or query", async () => {
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
         'SUBMITTED', 150000, 199000, 49000, now())
    `.execute(ctx.db);
    const port: SupplierPort = {
      getAvailability: () =>
        Promise.resolve({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
      createOrder: () => {
        throw new Error("create must not be called by an idempotency loser");
      },
      queryOrder: () => {
        throw new Error("query must not run while create is in-flight");
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
      purchaseEnabled: true,
      idempotencyKey,
    });
    expect(result).toEqual({
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId,
      queryKey: idempotencyKey,
    });
  });

  it("a rejected supplier response does not create an asset", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = createSandboxSupplierAdapter({ mode: "reject" });
    const res = await provisionFromSupplier(ctx.db, {
      orderId: f.orderId,
      supplierId: f.supplierId,
      supplierSkuId: f.supplierSkuId,
      externalSku: "REJECT-ME",
      costCeilingVnd: 150000,
      salePriceVnd: 199000,
      expectedSku: "REJECT-ME",
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

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where reserved_order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(0);
  });
});
