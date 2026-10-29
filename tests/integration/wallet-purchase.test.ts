import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  checkSelectedSupplierReadiness,
  type SupplierProviderResolverLike,
  type SupplierReadinessChecker,
} from "../../src/modules/supplier/readiness.js";
import type { SupplierCapability, SupplierProvider } from "../../src/modules/supplier/port.js";
import { createWalletPurchaseService } from "../../src/modules/wallet/purchase.js";
import { setStoreModeForTest } from "../../src/modules/commerce/store-mode.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, payment_intent, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
  await setStoreModeForTest(ctx.db, "OPEN", "test");
});

async function seedPaidCandidate(supplier = false): Promise<{
  customerId: string;
  orderId: string;
  walletAccountId: string;
}> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
  // Fund through the real ledger path. A raw `insert into wallet_account … balance_vnd`
  // would create an unreconciled cache, which the double-entry invariant refuses.
  const funded = await createWalletLedgerService(ctx.db).credit({
    customerId,
    amountVnd: 250_000n,
    idempotencyKey: `topup:seed:${orderId}`,
    correlationId: `seed:${orderId}`,
    reason: "seed funding",
  });
  if (!funded.ok) throw new Error(`seed funding failed: ${funded.code}`);
  const walletAccountId = funded.account.id;
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active, fulfillment_type)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 'P1M', 'CREDENTIAL', 0, ${supplier ? "SUPPLIER_ONLY" : "LOCAL_ONLY"}, 'RES-1', true, ${supplier ? "SUPPLIER_API" : "STOCK_ACCOUNT"})
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, fulfillment_type, status, expires_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 200000, 'P1M', 'CREDENTIAL', 0, ${supplier ? "SUPPLIER_ONLY" : "LOCAL_ONLY"}, ${supplier ? "SUPPLIER_API" : "STOCK_ACCOUNT"}, 'PENDING_PAYMENT', now() + interval '15 minutes')
  `.execute(ctx.db);
  if (supplier) {
    const supplierId = newId();
    const supplierSkuId = newId();
    await sql`
      insert into supplier (id, name, adapter_type, credential_vault_ref, status)
      values (${supplierId}, 'S', 'sandbox', 'vault:supplier', 'ACTIVE')
    `.execute(ctx.db);
    await sql`
      update supplier
      set provider_capabilities = '["ORDER_CREATE","DELIVERY_PAYLOAD"]'::jsonb
      where id = ${supplierId}
    `.execute(ctx.db);
    await sql`
      insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active)
      values (${supplierSkuId}, ${supplierId}, ${variantId}, 'EXT-SUP', 50000, 'CREDENTIAL', true)
    `.execute(ctx.db);
    await sql`update product_variant set supplier_sku_id = ${supplierSkuId} where id = ${variantId}`.execute(
      ctx.db,
    );
  } else {
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id, reserved_until)
      values (${newId()}, ${variantId}, 'LOCAL', ${"vault:" + newId().slice(-8)}, ${"fp-" + newId().slice(-8)}, 'RESERVED', ${orderId}, now() + interval '15 minutes')
    `.execute(ctx.db);
  }
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at, presented_at)
    values (${newId()}, ${orderId}, 'PRESENTED', 200000, 'merchant-1', ${"ORD" + orderId.slice(-8)}, now() + interval '15 minutes', now())
  `.execute(ctx.db);
  return { customerId, orderId, walletAccountId };
}
function fakeSupplierProvider(supplierId: string): SupplierProvider {
  return {
    providerKey: supplierId,
    displayName: "test",
    capabilities: new Set<SupplierCapability>(["ORDER_CREATE", "DELIVERY_PAYLOAD"]),
    health: async () => ({ ready: true, service: null }),
    getAvailability: async () => ({
      status: "AVAILABLE",
      observedAt: new Date().toISOString(),
      quantity: 1,
    }),
    createOrder: async () => ({ kind: "REJECTED", code: "unused", retryable: false }),
    queryOrder: async () => ({ status: "REJECTED", externalOrderId: "unused" }),
    cancelOrder: async () => ({ status: "UNSUPPORTED" }),
    requestRefund: async () => ({ status: "UNSUPPORTED" }),
    reconcile: async () => ({ observations: [], nextCursor: null }),
  };
}

async function readinessForOrder(orderId: string) {
  const selected = await sql<{ supplier_id: string }>`
    select ss.supplier_id
    from "order" o
    join product_variant v on v.id = o.variant_id
    join supplier_sku ss on ss.id = v.supplier_sku_id
    where o.id = ${orderId}
  `.execute(ctx.db);
  const row = selected.rows[0];
  if (!row) throw new Error("supplier seed missing");
  const provider = fakeSupplierProvider(row.supplier_id);
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

describe.skipIf(!hasDocker)("wallet purchase atomic service", () => {
  it("debits the wallet, marks the order paid, and voids live intents once", async () => {
    const { customerId, orderId, walletAccountId } = await seedPaidCandidate();
    const service = createWalletPurchaseService(ctx.db, async () => ({
      ok: false,
      reason: "SUPPLIER_UNAVAILABLE",
    }));

    const result = await service.purchase({
      customerId,
      orderId,
      idempotencyKey: "wallet-buy-1",
      correlationId: "wallet-corr-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("PAID");

    const wallet = await sql<{
      balance_vnd: string;
    }>`select balance_vnd from wallet_account where id = ${walletAccountId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("50000");

    const order = await sql<{
      status: string;
    }>`select status from "order" where id = ${orderId}`.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAID");

    const intent = await sql<{
      status: string;
    }>`select status from payment_intent where order_id = ${orderId}`.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("FAILED");
  });
  it("is idempotent under concurrent callers and records one debit", async () => {
    const { customerId, orderId } = await seedPaidCandidate();
    const service = createWalletPurchaseService(ctx.db);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.purchase({
          customerId,
          orderId,
          idempotencyKey: `concurrent-${index}`,
          correlationId: `corr-${index}`,
        }),
      ),
    );

    expect(results.filter((result) => result.ok && result.kind === "PAID")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.kind === "ALREADY_PAID")).toHaveLength(
      19,
    );
    const entries = await sql<{
      count: string;
    }>`select count(*)::text as count from wallet_ledger where idempotency_key like ${`purchase:${orderId}:%`}`.execute(
      ctx.db,
    );
    expect(entries.rows[0]?.count).toBe("1");
  });

  it("does not debit when the reservation is missing", async () => {
    const { customerId, orderId, walletAccountId } = await seedPaidCandidate();
    await sql`delete from digital_asset where reserved_order_id = ${orderId}`.execute(ctx.db);
    const result = await createWalletPurchaseService(ctx.db).purchase({
      customerId,
      orderId,
      idempotencyKey: "no-stock",
      correlationId: "no-stock-corr",
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_PAYABLE" });
    const wallet = await sql<{
      balance_vnd: string;
    }>`select balance_vnd from wallet_account where id = ${walletAccountId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("250000");
    const entries = await sql<{
      count: string;
    }>`select count(*)::text as count from wallet_ledger where wallet_account_id = ${walletAccountId} and idempotency_key like 'purchase:%'`.execute(
      ctx.db,
    );
    expect(entries.rows[0]?.count).toBe("0");
  });
  it("refuses an unready supplier order without changing financial or order state", async () => {
    const { customerId, orderId, walletAccountId } = await seedPaidCandidate(true);
    const supplierReadiness: SupplierReadinessChecker = async () => ({
      ok: false,
      reason: "SUPPLIER_UNAVAILABLE",
    });
    const result = await createWalletPurchaseService(ctx.db, supplierReadiness).purchase({
      customerId,
      orderId,
      idempotencyKey: "supplier-not-ready",
      correlationId: "supplier-not-ready-corr",
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_PAYABLE" });
    const wallet = await sql<{ balance_vnd: string }>`
      select balance_vnd from wallet_account where id = ${walletAccountId}
    `.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("250000");
    const entries = await sql<{ count: string }>`
      select count(*)::text as count
      from wallet_ledger
      where wallet_account_id = ${walletAccountId}
        and idempotency_key like 'purchase:%'
    `.execute(ctx.db);
    expect(entries.rows[0]?.count).toBe("0");
    const order = await sql<{ status: string }>`
      select status from "order" where id = ${orderId}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PENDING_PAYMENT");
  });
  it("does not debit when the selected mapping changes after preflight", async () => {
    const { customerId, orderId, walletAccountId } = await seedPaidCandidate(true);
    const preflight = await readinessForOrder(orderId);
    let changed = false;
    const supplierReadiness: SupplierReadinessChecker = async (variantId) => {
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
    const result = await createWalletPurchaseService(ctx.db, supplierReadiness).purchase({
      customerId,
      orderId,
      idempotencyKey: "supplier-mapping-race",
      correlationId: "supplier-mapping-race-corr",
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_PAYABLE" });
    const wallet = await sql<{ balance_vnd: string }>`
      select balance_vnd from wallet_account where id = ${walletAccountId}
    `.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("250000");
    const entries = await sql<{ count: string }>`
      select count(*)::text as count
      from wallet_ledger
      where wallet_account_id = ${walletAccountId}
        and idempotency_key like 'purchase:%'
    `.execute(ctx.db);
    expect(entries.rows[0]?.count).toBe("0");
    const order = await sql<{ status: string }>`
      select status from "order" where id = ${orderId}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PENDING_PAYMENT");
    const transitions = await sql<{ count: string }>`
      select count(*)::text as count from order_transition where order_id = ${orderId}
    `.execute(ctx.db);
    expect(transitions.rows[0]?.count).toBe("0");
  });

  it("does not probe an expired supplier order", async () => {
    const { customerId, orderId } = await seedPaidCandidate(true);
    await sql`
      update "order" set expires_at = now() - interval '1 minute' where id = ${orderId}
    `.execute(ctx.db);
    let calls = 0;
    const supplierReadiness: SupplierReadinessChecker = async () => {
      calls += 1;
      return { ok: false, reason: "SUPPLIER_UNAVAILABLE" };
    };
    const result = await createWalletPurchaseService(ctx.db, supplierReadiness).purchase({
      customerId,
      orderId,
      idempotencyKey: "supplier-expired",
      correlationId: "supplier-expired-corr",
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_PAYABLE" });
    expect(calls).toBe(0);
  });

  it("does not probe a supplier order while the store is closed", async () => {
    const { customerId, orderId } = await seedPaidCandidate(true);
    await setStoreModeForTest(ctx.db, "CLOSED", "test");
    let calls = 0;
    const supplierReadiness: SupplierReadinessChecker = async () => {
      calls += 1;
      return { ok: false, reason: "SUPPLIER_UNAVAILABLE" };
    };
    const result = await createWalletPurchaseService(ctx.db, supplierReadiness).purchase({
      customerId,
      orderId,
      idempotencyKey: "supplier-closed",
      correlationId: "supplier-closed-corr",
    });

    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_PAYABLE" });
    expect(calls).toBe(0);
  });
});
