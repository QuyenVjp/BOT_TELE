import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { createWalletRefundService } from "../../src/modules/wallet/refund.js";
import { dockerAvailable, startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => { await ctx?.teardown(); });
beforeEach(async () => {
  await sql`truncate table wallet_ledger, wallet_account, "order", product_variant, product, category, customer cascade`.execute(ctx.db);
});

async function seedRefundCandidate(status = "REFUND_PENDING") {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)`.execute(ctx.db);
  await sql`insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', ${status})`.execute(ctx.db);
  await createWalletLedgerService(ctx.db).credit({ customerId, amountVnd: 100000n, idempotencyKey: "seed-credit", correlationId: "seed", reason: "seed" });
  await createWalletLedgerService(ctx.db).debit({ customerId, amountVnd: 100000n, idempotencyKey: `purchase:${orderId}:seed`, correlationId: "seed-debit", reason: "seed purchase" });
  return { customerId, orderId };
}

describe.skipIf(!hasDocker)("wallet refund service", () => {
  it("credits the exact wallet debit and is replay-safe", async () => {
    const { orderId, customerId } = await seedRefundCandidate();
    const service = createWalletRefundService(ctx.db);
    const input = { orderId, correlationId: "refund-corr", approvedBy: "12345" };
    expect(await service.refund(input)).toMatchObject({ ok: true, kind: "REFUNDED", orderId });
    expect(await service.refund(input)).toMatchObject({ ok: true, kind: "ALREADY_REFUNDED", orderId });
    const wallet = await sql<{ balance_vnd: string }>`select balance_vnd from wallet_account where customer_id = ${customerId}`.execute(ctx.db);
    expect(wallet.rows[0]?.balance_vnd).toBe("100000");
    const credits = await sql<{ count: string }>`select count(*)::text as count from wallet_ledger l join wallet_account a on a.id=l.wallet_account_id where a.customer_id=${customerId} and l.idempotency_key=${`refund:${orderId}`}`.execute(ctx.db);
    expect(credits.rows[0]?.count).toBe("1");
  });

  it("rejects refunds that are not pending or were not wallet paid", async () => {
    const notPending = await seedRefundCandidate("PAID");
    expect(await createWalletRefundService(ctx.db).refund({ orderId: notPending.orderId, correlationId: "c", approvedBy: "12345" })).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    await sql`truncate table wallet_ledger, wallet_account, "order", product_variant, product, category, customer cascade`.execute(ctx.db);
    const noWalletPayment = await seedRefundCandidate();
    await sql`delete from wallet_ledger where idempotency_key like ${`purchase:${noWalletPayment.orderId}:%`}`.execute(ctx.db);
    expect(await createWalletRefundService(ctx.db).refund({ orderId: noWalletPayment.orderId, correlationId: "c2", approvedBy: "12345" })).toMatchObject({ ok: false, code: "NOT_WALLET_PAID" });
  });
});
