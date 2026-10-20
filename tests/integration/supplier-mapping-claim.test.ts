import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import { checkSupplierPurchaseReadiness } from "../../src/modules/supplier/readiness.js";
import { provisionFromSupplier } from "../../src/modules/supplier/service.js";
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
    truncate table supplier_catalog_product, digital_asset, supplier_order, supplier_sku,
      supplier, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function waitForClaimLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await sql<{ pid: number }>`
      select a.pid
      from pg_stat_activity a
      where a.datname = current_database()
        and a.wait_event_type = 'Lock'
        and position('supplier_order' in lower(coalesce(a.query, ''))) > 0
      limit 1
    `.execute(ctx.db);
    if (waiting.rows[0]) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error("supplier first-attempt claim did not wait on the owner transaction");
}

describe("supplier mapping first-attempt claim", () => {
  it("does not create upstream order after the owner disables the selected mapping", async () => {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const customerId = newId();
    const orderId = newId();
    const supplierId = newId();
    const supplierSkuId = newId();
    const catalogId = newId();
    const supplierOrderId = newId();
    const externalSku = `RACE-${supplierSkuId}`;
    const idempotencyKey = `${orderId}:${supplierSkuId}`;

    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Race category', ${categoryId.slice(-8)}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order)
      values (${productId}, ${categoryId}, 'Race product', ${productId.slice(-8)}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
         stock_policy, resale_evidence_id)
      values
        (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'Race variant', 199000,
         'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY', 'RES-RACE')
    `.execute(ctx.db);
    await sql`
      insert into customer (id, status, locale)
      values (${customerId}, 'ACTIVE', 'vi')
    `.execute(ctx.db);
    await sql`
      insert into "order"
        (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
         price_vnd, duration_code, delivery_type, status, paid_at)
      values
        (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'Race product',
         'Race variant', 199000, 'P1M', 'CREDENTIAL', 'PAID', now())
    `.execute(ctx.db);
    await sql`
      insert into supplier
        (id, name, adapter_type, credential_vault_ref, status, provider_capabilities)
      values
        (${supplierId}, 'Race supplier', 'sandbox', 'vault:race', 'ACTIVE',
         '["CATALOG_LIST","ORDER_CREATE"]'::jsonb)
    `.execute(ctx.db);
    await sql`
      insert into supplier_sku
        (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
      values
        (${supplierSkuId}, ${supplierId}, ${variantId}, ${externalSku}, 120000,
         'VN', 'CREDENTIAL', true)
    `.execute(ctx.db);
    await sql`
      update product_variant
      set supplier_sku_id = ${supplierSkuId}
      where id = ${variantId}
    `.execute(ctx.db);
    await sql`
      insert into supplier_catalog_product
        (id, supplier_id, external_product_id, external_variant_id, upstream_name_vi,
         availability, domain_status, stock_type, stock_quantity, supplier_cost_vnd,
         currency, selection_status, is_enabled, is_missing, local_product_id,
         local_variant_id, supplier_sku_id)
      values
        (${catalogId}, ${supplierId}, ${externalSku}, '', 'Race supplier product',
         'AVAILABLE', 'SUPPORTED', 'FINITE', 1, 120000, 'VND', 'SELECTED', true,
         false, ${productId}, ${variantId}, ${supplierSkuId})
    `.execute(ctx.db);
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot,
         submitted_at, attempt_count)
      values
        (${supplierOrderId}, ${supplierId}, ${supplierSkuId}, ${orderId}, ${idempotencyKey},
         'race-fingerprint', 'SUBMITTED', 120000, 199000, 79000, null, 0)
    `.execute(ctx.db);

    const sandbox = createSandboxSupplierAdapter({ mode: "fulfill" });
    let createCalls = 0;
    const port = {
      ...sandbox,
      async createOrder(input: Parameters<typeof sandbox.createOrder>[0]) {
        createCalls += 1;
        return sandbox.createOrder(input);
      },
    };
    const initial = await checkSupplierPurchaseReadiness(ctx.db, {
      variantId,
      supplierId,
      supplierSkuId,
      provider: port,
      purchaseEnabled: true,
    });
    expect(initial).toMatchObject({ ok: true, externalSku, costVnd: 120000 });

    const owner = await ctx.handle.pool.connect();
    let ownerInTransaction = true;
    await owner.query("begin");
    try {
      // Match owner curation's lock order before holding the pre-claim supplier row.
      await owner.query("select id from supplier_catalog_product where id = $1 for update", [
        catalogId,
      ]);
      await owner.query("select id from product_variant where id = $1 for update", [variantId]);
      await owner.query("select id from supplier_sku where id = $1 for update", [supplierSkuId]);
      await owner.query("select id from supplier_order where id = $1 for update", [
        supplierOrderId,
      ]);

      const pending = provisionFromSupplier(ctx.db, {
        orderId,
        supplierId,
        supplierSkuId,
        externalSku,
        costCeilingVnd: 120000,
        salePriceVnd: 199000,
        expectedSku: externalSku,
        deliveryType: "CREDENTIAL",
        durationCode: "P1M",
        region: "VN",
        correlationId: "supplier-mapping-claim-race",
        idempotencyKey,
        port,
        vault: createInMemoryVault(),
        purchaseEnabled: true,
      });

      await waitForClaimLock();
      await owner.query(
        `update supplier_catalog_product
         set is_enabled = false, version = version + 1, updated_at = now()
         where id = $1`,
        [catalogId],
      );
      await owner.query("commit");
      ownerInTransaction = false;

      await pending;
      expect(createCalls).toBe(0);
      const persisted = await sql<{
        attempt_count: number;
        external_order_id: string | null;
      }>`
        select attempt_count, external_order_id
        from supplier_order
        where id = ${supplierOrderId}
      `.execute(ctx.db);
      expect(persisted.rows[0]).toMatchObject({ attempt_count: 0, external_order_id: null });
    } finally {
      if (ownerInTransaction) await owner.query("rollback");
      owner.release();
    }
  });
});
