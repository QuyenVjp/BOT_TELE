import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { listOrderHistory, getOrderDetailForCustomer } from "../../src/modules/commerce/history.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T080 — Order history BOLA, cursor pagination, status projection, unpaid-reopen
 * (FR-018, SR-003).
 *
 * A customer sees ONLY their own orders. Detail lookups are customer-scoped so a
 * guessed/enumerated order id belonging to another customer returns null (no
 * existence oracle). Pagination is keyset and stable across inserts.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedCustomer(): Promise<string> {
  const id = newId();
  await sql`insert into customer (id, status, locale) values (${id}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  return id;
}

async function seedVariant(): Promise<string> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  return variantId;
}

async function seedOrder(
  customerId: string,
  variantId: string,
  status: string,
  createdOffsetSec = 0,
): Promise<string> {
  const orderId = newId();
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, created_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'Netflix', 'Premium 1 tháng',
      100000, 'P1M', 'CREDENTIAL', ${status}, now() - (${createdOffsetSec} || ' seconds')::interval)
  `.execute(ctx.db);
  return orderId;
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

describe("order history BOLA + pagination (FR-018 / SR-003)", () => {
  it("returns only the requesting customer's orders", async () => {
    const alice = await seedCustomer();
    const bob = await seedCustomer();
    const variant = await seedVariant();
    await seedOrder(alice, variant, "COMPLETED", 30);
    await seedOrder(alice, variant, "PENDING_PAYMENT", 20);
    await seedOrder(bob, variant, "PAID", 10);

    const page = await listOrderHistory(ctx.db, { customerId: alice, limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((o) => o.customerId === alice)).toBe(true);
  });

  it("paginates with a stable keyset cursor (no overlap, no gap)", async () => {
    const alice = await seedCustomer();
    const variant = await seedVariant();
    // 5 orders, newest first.
    for (let i = 0; i < 5; i++) {
      await seedOrder(alice, variant, "COMPLETED", i * 10);
    }

    const page1 = await listOrderHistory(ctx.db, { customerId: alice, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listOrderHistory(ctx.db, {
      customerId: alice,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(2);

    const page3 = await listOrderHistory(ctx.db, {
      customerId: alice,
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    // No id appears twice across pages.
    const ids = [...page1.items, ...page2.items, ...page3.items].map((o) => o.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("detail lookup is customer-scoped — a foreign order id returns null", async () => {
    const alice = await seedCustomer();
    const bob = await seedCustomer();
    const variant = await seedVariant();
    const bobOrder = await seedOrder(bob, variant, "PAID");

    // Alice cannot read Bob's order by id (BOLA).
    const asAlice = await getOrderDetailForCustomer(ctx.db, {
      orderId: bobOrder,
      customerId: alice,
    });
    expect(asAlice).toBeNull();

    // Bob can read his own.
    const asBob = await getOrderDetailForCustomer(ctx.db, {
      orderId: bobOrder,
      customerId: bob,
    });
    expect(asBob?.id).toBe(bobOrder);
  });

  it("history projects the order status for the customer view", async () => {
    const alice = await seedCustomer();
    const variant = await seedVariant();
    await seedOrder(alice, variant, "PAYMENT_NEEDS_REVIEW");
    const page = await listOrderHistory(ctx.db, { customerId: alice, limit: 10 });
    expect(page.items[0]?.status).toBe("PAYMENT_NEEDS_REVIEW");
  });
});
