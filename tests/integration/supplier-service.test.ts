import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import {
  provisionFromSupplier,
  recoverUnknownSupplierOrder,
} from "../../src/modules/supplier/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

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

    const so = await sql<{ status: string }>`
      select status from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(so.rows[0]?.status).toBe("FULFILLED");
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

  it("timeout maps to UNKNOWN and is recovered via query (never re-create)", async () => {
    const f = await seedPaidOrderWithSupplierSku();
    const vault = createInMemoryVault();
    const port = createSandboxSupplierAdapter({ mode: "timeout-then-fulfill" });

    const first = await provisionFromSupplier(ctx.db, {
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
      correlationId: "sup-to",
      port,
      vault,
      idempotencyKey: "idem-timeout-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.kind).toBe("UNKNOWN");
    if (first.kind !== "UNKNOWN") return;

    const so = await sql<{ status: string }>`
      select status from supplier_order where id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(so.rows[0]?.status).toBe("UNKNOWN");

    // Recover via query — do NOT re-create.
    const recovered = await recoverUnknownSupplierOrder(ctx.db, {
      supplierOrderId: first.supplierOrderId,
      queryKey: first.queryKey,
      expectedSku: f.externalSku,
      deliveryType: "CREDENTIAL",
      durationCode: "P1M",
      region: "VN",
      correlationId: "sup-recover",
      port,
      vault,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.kind).toBe("FULFILLED");

    const after = await sql<{ status: string }>`
      select status from supplier_order where id = ${first.supplierOrderId}
    `.execute(ctx.db);
    expect(after.rows[0]?.status).toBe("FULFILLED");

    // Still exactly one supplier_order row.
    const count = await sql<{ count: string }>`
      select count(*)::text as count from supplier_order where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
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
