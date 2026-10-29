import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { presentPaymentForOrder } from "../../src/modules/payments/service.js";
import {
  checkSelectedSupplierReadiness,
  type SupplierProviderResolverLike,
} from "../../src/modules/supplier/readiness.js";
import type { SupplierCapability, SupplierProvider } from "../../src/modules/supplier/port.js";
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
    truncate table outbox_event, payment_intent, quantity_stock_ledger, variant_quantity_stock,
      supplier_order, supplier_sku, supplier, digital_asset, order_transition, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedOrder(
  policy: string | null,
  fulfillmentType = "STOCK_ACCOUNT",
): Promise<string> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, fulfillment_type)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', ${fulfillmentType})
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type, status, expires_at)
    values
      (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 100000,
       'P1M', 'CREDENTIAL', ${policy}, ${fulfillmentType}, 'PENDING_PAYMENT', now() + interval '15 minutes')
  `.execute(ctx.db);
  if (fulfillmentType === "STOCK_ACCOUNT") {
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id, reserved_until)
      values (${newId()}, ${variantId}, 'LOCAL', ${"vault:" + orderId}, ${"fp-" + orderId}, 'RESERVED', ${orderId}, now() + interval '15 minutes')
    `.execute(ctx.db);
  } else if (fulfillmentType === "SUPPLIER_API") {
    const supplierId = newId();
    await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${supplierId}, 'Primary', 'sandbox', 'vault:supplier', 'ACTIVE')`.execute(
      ctx.db,
    );
    await sql`
      insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active)
      values (${newId()}, ${supplierId}, ${variantId}, 'EXT-SUP', 50000, 'CREDENTIAL', true)
    `.execute(ctx.db);
    await sql`
      update supplier
      set provider_capabilities = '["ORDER_CREATE","DELIVERY_PAYLOAD"]'::jsonb
      where id = ${supplierId}
    `.execute(ctx.db);
    await sql`
      update product_variant
      set supplier_sku_id = (select id from supplier_sku where supplier_id = ${supplierId} and variant_id = ${variantId} limit 1)
      where id = ${variantId}
    `.execute(ctx.db);
  }
  return orderId;
}

function fakeSupplierProvider(
  supplierId: string,
  ready: boolean,
  availability: "AVAILABLE" | "OUT" | "UNKNOWN",
): SupplierProvider {
  return {
    providerKey: supplierId,
    displayName: "test",
    capabilities: new Set<SupplierCapability>(["ORDER_CREATE", "DELIVERY_PAYLOAD"]),
    health: async () => ({ ready, service: null }),
    getAvailability: async () => ({
      status: availability,
      observedAt: new Date().toISOString(),
      quantity: availability === "OUT" ? 0 : 1,
    }),
    createOrder: async () => ({ kind: "REJECTED", code: "unused", retryable: false }),
    queryOrder: async () => ({ status: "REJECTED", externalOrderId: "unused" }),
    cancelOrder: async () => ({ status: "UNSUPPORTED" }),
    requestRefund: async () => ({ status: "UNSUPPORTED" }),
    reconcile: async () => ({ observations: [], nextCursor: null }),
  };
}

async function readinessForOrder(
  orderId: string,
  ready = true,
  availability: "AVAILABLE" | "OUT" | "UNKNOWN" = "AVAILABLE",
) {
  const selected = await sql<{ supplier_id: string }>`
    select ss.supplier_id
    from "order" o
    join product_variant v on v.id = o.variant_id
    join supplier_sku ss on ss.id = v.supplier_sku_id
    where o.id = ${orderId}
  `.execute(ctx.db);
  const row = selected.rows[0];
  if (!row) throw new Error("supplier seed missing");
  const provider = fakeSupplierProvider(row.supplier_id, ready, availability);
  const resolver: SupplierProviderResolverLike = {
    resolve: async (supplierId) => (supplierId === row.supplier_id ? provider : null),
  };
  return (variantId: string) =>
    checkSelectedSupplierReadiness(ctx.db, {
      variantId,
      providerResolver: resolver,
      purchaseEnabled: true,
    });
}

describe("payment stock-policy fail-closed guard", () => {
  for (const policy of ["PAUSED", null, "UNKNOWN_POLICY"] as const) {
    it(`does not mint an intent or VietQR for ${String(policy)}`, async () => {
      const orderId = await seedOrder(policy);
      const result = await presentPaymentForOrder(ctx.db, {
        orderId,
        merchantAccountId: "0123456789",
        beneficiaryAccountNumber: "9876543210",
        bankBin: "970422",
        accountName: "SHOP DIGITAL MVP",
        bankName: "MB Bank",
        correlationId: `policy-${String(policy)}`,
      });
      expect(result).toEqual({ ok: false, error: "policy blocked" });

      const count = await sql<{ count: number }>`
        select count(*)::int as count from payment_intent where order_id = ${orderId}
      `.execute(ctx.db);
      expect(count.rows[0]?.count).toBe(0);
    });
  }

  it("does not mint an intent from a supplier-SKU mapping alone", async () => {
    const orderId = await seedOrder("SUPPLIER_ONLY", "SUPPLIER_API");
    const result = await presentPaymentForOrder(ctx.db, {
      orderId,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "policy-supplier-mapping-only",
    });
    expect(result).toEqual({ ok: false, error: "supplier unavailable" });
    const count = await sql<{ count: number }>`
      select count(*)::int as count from payment_intent where order_id = ${orderId}
    `.execute(ctx.db);
    expect(count.rows[0]?.count).toBe(0);
  });

  for (const [label, ready, availability] of [
    ["health false", false, "AVAILABLE"],
    ["availability OUT", true, "OUT"],
    ["availability UNKNOWN", true, "UNKNOWN"],
  ] as const) {
    it(`does not mint an intent when supplier ${label}`, async () => {
      const orderId = await seedOrder("SUPPLIER_ONLY", "SUPPLIER_API");
      const supplierReadiness = await readinessForOrder(orderId, ready, availability);
      const result = await presentPaymentForOrder(ctx.db, {
        orderId,
        merchantAccountId: "0123456789",
        beneficiaryAccountNumber: "9876543210",
        bankBin: "970422",
        accountName: "SHOP DIGITAL MVP",
        bankName: "MB Bank",
        correlationId: `policy-supplier-${label}`,
        supplierReadiness,
      });
      expect(result).toEqual({ ok: false, error: "supplier unavailable" });
      const count = await sql<{ count: number }>`
        select count(*)::int as count from payment_intent where order_id = ${orderId}
      `.execute(ctx.db);
      expect(count.rows[0]?.count).toBe(0);
    });
  }

  it("mints an intent for a healthy selected supplier SKU", async () => {
    const orderId = await seedOrder("SUPPLIER_ONLY", "SUPPLIER_API");
    const supplierReadiness = await readinessForOrder(orderId);
    const result = await presentPaymentForOrder(ctx.db, {
      orderId,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "policy-supplier-ok",
      supplierReadiness,
    });
    expect(result.ok).toBe(true);
  });
  it("does not mint an intent when the selected mapping changes after preflight", async () => {
    const orderId = await seedOrder("SUPPLIER_ONLY", "SUPPLIER_API");
    const preflight = await readinessForOrder(orderId);
    let changed = false;
    const supplierReadiness = async (variantId: string) => {
      const readiness = await preflight(variantId);
      if (readiness.ok && !changed) {
        changed = true;
        await sql`
          update supplier_sku
          set external_sku = 'EXT-SUP-CHANGED', version = version + 1
          where id = (select supplier_sku_id from product_variant where id = ${variantId})
        `.execute(ctx.db);
      }
      return readiness;
    };
    const result = await presentPaymentForOrder(ctx.db, {
      orderId,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "policy-supplier-mapping-race",
      supplierReadiness,
    });
    expect(result).toEqual({ ok: false, error: "supplier unavailable" });
    const count = await sql<{ count: number }>`
      select count(*)::int as count from payment_intent where order_id = ${orderId}
    `.execute(ctx.db);
    expect(count.rows[0]?.count).toBe(0);
  });
  it("reuses a live supplier intent if provider readiness later degrades", async () => {
    const orderId = await seedOrder("SUPPLIER_ONLY", "SUPPLIER_API");
    const payment = {
      orderId,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "policy-supplier-reuse",
    };
    const first = await presentPaymentForOrder(ctx.db, {
      ...payment,
      supplierReadiness: await readinessForOrder(orderId),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const reopened = await presentPaymentForOrder(ctx.db, {
      ...payment,
      supplierReadiness: await readinessForOrder(orderId, false, "OUT"),
    });
    expect(reopened).toMatchObject({ ok: true, intentId: first.intentId });
  });

  it("keeps local-stock payment independent of supplier readiness", async () => {
    const orderId = await seedOrder("LOCAL_ONLY", "STOCK_ACCOUNT");
    const result = await presentPaymentForOrder(ctx.db, {
      orderId,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "policy-local-stock",
      supplierReadiness: async () => ({
        ok: false,
        reason: "SUPPLIER_UNAVAILABLE",
      }),
    });
    expect(result.ok).toBe(true);
  });
});
