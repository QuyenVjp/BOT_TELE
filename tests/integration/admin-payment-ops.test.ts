import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { listAdminPaymentOps } from "../../src/modules/admin/payment-ops.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Goal §95: the operator's payment queues. What matters here is the predicate behind each view —
 * an intent that has not expired belongs to "pending" and not to "late", unmatched money is not
 * filed as a generic discrepancy, and a test product's payment is nobody's queue.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table shop_refund_obligation, discrepancy, payment_intent, "order", product_variant, product,
      category, customer cascade
  `.execute(ctx.db);
});

async function seedOrder(isTest = false): Promise<{ orderId: string; variantId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${"c-" + categoryId}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test) values (${productId}, ${categoryId}, 'P', ${"p-" + productId}, true, 1, ${isTest})`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 1000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, supplier_policy_snapshot, status)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 1000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'PENDING_PAYMENT')
  `.execute(ctx.db);
  return { orderId, variantId };
}

async function seedIntent(
  orderId: string,
  status: string,
  expiresInMinutes: number,
): Promise<string> {
  const intentId = newId();
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at)
    values (${intentId}, ${orderId}, ${status}, 1000, 'acc-1', ${"SEPAY" + intentId.slice(-8)},
      now() + (${expiresInMinutes} * interval '1 minute'))
  `.execute(ctx.db);
  return intentId;
}

describe("admin payment queues", () => {
  it("separates a live intent from a lapsed one, and keeps them out of each other's view", async () => {
    const live = await seedOrder();
    const lapsed = await seedOrder();
    const liveIntent = await seedIntent(live.orderId, "PRESENTED", 15);
    const lapsedIntent = await seedIntent(lapsed.orderId, "PRESENTED", -15);

    const pending = await listAdminPaymentOps(ctx.db, "pending");
    expect(pending.rows.map((row) => row.id)).toEqual([liveIntent]);
    expect(pending.rows.map((row) => row.id)).not.toContain(lapsedIntent);

    const late = await listAdminPaymentOps(ctx.db, "late");
    expect(late.rows.map((row) => row.id)).toEqual([lapsedIntent]);
    expect(late.rows.map((row) => row.id)).not.toContain(liveIntent);
  });

  it("files unmatched money apart from other discrepancies", async () => {
    const { orderId } = await seedOrder();
    const unmatchedId = newId();
    const collisionId = newId();
    await sql`
      insert into discrepancy (id, type, status, reason, owner, order_id)
      values (${unmatchedId}, 'UNMATCHED', 'OPEN', 'không khớp nội dung', 'OPS', ${orderId})
    `.execute(ctx.db);
    await sql`
      insert into discrepancy (id, type, status, reason, owner, order_id)
      values (${collisionId}, 'REFERENCE_COLLISION', 'OPEN', 'nội dung trùng', 'OPS', ${orderId})
    `.execute(ctx.db);

    const unmatched = await listAdminPaymentOps(ctx.db, "unmatched");
    expect(unmatched.rows.map((row) => row.id)).toEqual([unmatchedId]);

    const other = await listAdminPaymentOps(ctx.db, "discrepancy");
    expect(other.rows.map((row) => row.id)).toEqual([collisionId]);
  });

  it("shows only open refund obligations, and hides test payments from every queue", async () => {
    const real = await seedOrder();
    const test = await seedOrder(true);
    await seedIntent(real.orderId, "PRESENTED", 15);
    const testIntent = await seedIntent(test.orderId, "PRESENTED", 15);
    const refundCustomerId = newId();
    await sql`insert into customer (id, status, locale) values (${refundCustomerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const openId = newId();
    await sql`
      insert into shop_refund_obligation (id, customer_id, amount_vnd, status, reason, order_id, created_by)
      values (${openId}, ${refundCustomerId}, 1000, 'OPEN', 'shop cần hoàn', ${real.orderId}, 'ROOT_ADMIN')
    `.execute(ctx.db);

    const refunds = await listAdminPaymentOps(ctx.db, "refund");
    expect(refunds.rows.map((row) => row.id)).toEqual([openId]);

    const pending = await listAdminPaymentOps(ctx.db, "pending");
    expect(pending.rows.map((row) => row.id)).not.toContain(testIntent);
  });
});
