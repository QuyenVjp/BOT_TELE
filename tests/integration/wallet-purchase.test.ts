import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createWalletPurchaseService } from "../../src/modules/wallet/purchase.js";
import { dockerAvailable, startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, payment_intent, "order", product_variant, product, category, customer cascade`.execute(ctx.db);
});

async function seedPaidCandidate(): Promise<{ customerId: string; orderId: string; walletAccountId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const walletAccountId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
  await sql`insert into wallet_account (id, customer_id, balance_vnd) values (${walletAccountId}, ${customerId}, 250000)`.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${'SKU-' + variantId.slice(-8)}, 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status, expires_at)
    values (${orderId}, ${'ORD-' + orderId}, ${customerId}, ${variantId}, 'P', 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'PENDING_PAYMENT', now() + interval '15 minutes')
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id, reserved_until)
    values (${newId()}, ${variantId}, 'LOCAL', ${'vault:' + newId().slice(-8)}, ${'fp-' + newId().slice(-8)}, 'RESERVED', ${orderId}, now() + interval '15 minutes')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at, presented_at)
    values (${newId()}, ${orderId}, 'PRESENTED', 200000, 'merchant-1', ${'ORD' + orderId.slice(-8)}, now() + interval '15 minutes', now())
  `.execute(ctx.db);
  return { customerId, orderId, walletAccountId };
}

describe.skipIf(!hasDocker)("wallet purchase atomic service", () => {
  it("debits the wallet, marks the order paid, and voids live intents once", async () => {
    const { customerId, orderId, walletAccountId } = await seedPaidCandidate();
    const service = createWalletPurchaseService(ctx.db);

    const result = await service.purchase({
      customerId,
      orderId,
      idempotencyKey: "wallet-buy-1",
      correlationId: "wallet-corr-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("PAID");

    const wallet = await sql<{ balance_vnd: string }>`select balance_vnd from wallet_account where id = ${walletAccountId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("50000");

    const order = await sql<{ status: string }>`select status from "order" where id = ${orderId}`.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAID");

    const intent = await sql<{ status: string }>`select status from payment_intent where order_id = ${orderId}`.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("FAILED");
  });
  it("is idempotent under concurrent callers and records one debit", async () => {
    const { customerId, orderId } = await seedPaidCandidate();
    const service = createWalletPurchaseService(ctx.db);

    const results = await Promise.all([
      service.purchase({ customerId, orderId, idempotencyKey: "concurrent-a", correlationId: "corr-a" }),
      service.purchase({ customerId, orderId, idempotencyKey: "concurrent-b", correlationId: "corr-b" }),
    ]);

    expect(results.filter((result) => result.ok && result.kind === "PAID")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.kind === "ALREADY_PAID")).toHaveLength(1);
    const entries = await sql<{ count: string }>`select count(*)::text as count from wallet_ledger where idempotency_key like ${`purchase:${orderId}:%`}`.execute(ctx.db);
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
    const wallet = await sql<{ balance_vnd: string }>`select balance_vnd from wallet_account where id = ${walletAccountId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("250000");
    const entries = await sql<{ count: string }>`select count(*)::text as count from wallet_ledger where wallet_account_id = ${walletAccountId}`.execute(ctx.db);
    expect(entries.rows[0]?.count).toBe("0");
  });
});
