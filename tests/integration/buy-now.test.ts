import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  buyNow,
  cancelUnpaidOrder,
  expireOverdueOrders,
  type BuyNowResult,
} from "../../src/modules/commerce/buy-now.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T039 — Buy Now (FR-006, FR-007, FR-008, FR-010).
 *
 * FR-006: `Mua ngay` revalidates variant/price/active/stock/resale BEFORE
 *         creating an Order — a stale or unauthorized variant is rejected.
 * FR-007: the Order carries an IMMUTABLE snapshot of name/price/duration/
 *         delivery/warranty/policy — later catalog edits never mutate it.
 * FR-010: a double-tap (same idempotency fingerprint) creates exactly one Order.
 *
 * The buy path here creates the Order in PENDING_PAYMENT state; it never settles
 * payment (that is US2's SePay evidence path) and never starts fulfillment.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Seed {
  customerId: string;
  categoryId: string;
  productId: string;
  variantId: string;
  price: number;
}

async function seed(
  overrides: {
    price?: number;
    stockPolicy?: string;
    resale?: string | null;
    active?: boolean;
    /** How many AVAILABLE local assets to stock (default 3). */
    assetCount?: number;
  } = {},
): Promise<Seed> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const price = overrides.price ?? 120000;

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', 'giai-tri', true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', 'netflix', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${variantId}, ${productId}, 'NF-1M', 'Gói 1 tháng', ${price}, 'P1M', 'CREDENTIAL', 30,
       ${overrides.stockPolicy ?? "LOCAL_ONLY"}, ${overrides.resale === undefined ? "RES-NF1" : overrides.resale},
       ${overrides.active ?? true}, 1)
  `.execute(ctx.db);

  // FR-006a: LOCAL_ONLY / LOCAL_THEN_SUPPLIER variants require finite local stock
  // to be reserved before Order/Payment Intent creation. Seed enough AVAILABLE
  // assets so the single-buyer cases continue to pass.
  const stockPolicy = overrides.stockPolicy ?? "LOCAL_ONLY";
  if (stockPolicy === "LOCAL_ONLY" || stockPolicy === "LOCAL_THEN_SUPPLIER") {
    const n = overrides.assetCount ?? 3;
    for (let i = 0; i < n; i++) {
      const assetId = newId();
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
      `.execute(ctx.db);
    }
  }

  return { customerId, categoryId, productId, variantId, price };
}

beforeEach(async () => {
  await sql`truncate table order_transition, payment_intent, digital_asset, "order", product_variant, product_alias, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("Buy Now creates one immutable Order (FR-006/FR-007)", () => {
  it("creates a PENDING_PAYMENT order with an immutable snapshot", async () => {
    const s = await seed();
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-1",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(true);
    const order = (result as Extract<BuyNowResult, { ok: true }>).order;
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(order.priceVnd).toBe(String(s.price));
    expect(order.productNameVi).toBe("Netflix");
    expect(order.variantNameVi).toBe("Gói 1 tháng");
    expect(order.deliveryType).toBe("CREDENTIAL");
    expect(order.warrantyDays).toBe(30);
    expect(order.orderNumber).toBeTruthy();

    // Mutating the catalog afterward must not change the order snapshot.
    await sql`update product_variant set price_vnd = 999000, name_vi = 'Đổi tên' where id = ${s.variantId}`.execute(
      ctx.db,
    );
    const reread = await sql<{ price_vnd: string; variant_name_vi: string }>`
      select price_vnd, variant_name_vi from "order" where id = ${order.id}
    `.execute(ctx.db);
    expect(reread.rows[0]?.price_vnd).toBe(String(s.price));
    expect(reread.rows[0]?.variant_name_vi).toBe("Gói 1 tháng");
  });

  it("records an order transition for the creation", async () => {
    const s = await seed();
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-1",
      correlationId: "corr-xyz",
    });
    const order = (result as Extract<BuyNowResult, { ok: true }>).order;
    const transitions = await sql<{ to_status: string; correlation_id: string }>`
      select to_status, correlation_id from order_transition where order_id = ${order.id}
    `.execute(ctx.db);
    expect(transitions.rows.some((t) => t.to_status === "PENDING_PAYMENT")).toBe(true);
    expect(transitions.rows.every((t) => t.correlation_id === "corr-xyz")).toBe(true);
  });
});

describe("Buy Now revalidation (FR-006)", () => {
  it("rejects when the price changed since the customer saw it", async () => {
    const s = await seed({ price: 120000 });
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: 100000, // stale
      idempotencyKey: "buy-stale",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(false);
    expect((result as Extract<BuyNowResult, { ok: false }>).code).toBe("PRICE_CHANGED");
    const count = await sql<{ count: string }>`select count(*)::text as count from "order"`.execute(
      ctx.db,
    );
    expect(Number(count.rows[0]?.count)).toBe(0);
  });

  it("rejects a paused (out-of-stock) variant", async () => {
    const s = await seed({ stockPolicy: "PAUSED" });
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-paused",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(false);
    expect((result as Extract<BuyNowResult, { ok: false }>).code).toBe("NO_STOCK");
  });

  it("rejects an unauthorized variant (no resale evidence, SR-007)", async () => {
    const s = await seed({ resale: null });
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-noauth",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(false);
    expect(["POLICY_BLOCKED", "VARIANT_UNAVAILABLE"]).toContain(
      (result as Extract<BuyNowResult, { ok: false }>).code,
    );
  });

  it("rejects an inactive variant", async () => {
    const s = await seed({ active: false });
    const result = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-inactive",
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(false);
    expect((result as Extract<BuyNowResult, { ok: false }>).code).toBe("VARIANT_UNAVAILABLE");
  });
});

describe("Buy Now idempotency (FR-010)", () => {
  it("a double-tap with the same idempotency key creates exactly one order", async () => {
    const s = await seed();
    const first = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "double-tap-1",
      correlationId: "corr-1",
    });
    const second = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "double-tap-1",
      correlationId: "corr-1",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstOrder = (first as Extract<BuyNowResult, { ok: true }>).order;
    const secondOrder = (second as Extract<BuyNowResult, { ok: true }>).order;
    expect(secondOrder.id).toBe(firstOrder.id);

    const count = await sql<{ count: string }>`select count(*)::text as count from "order"`.execute(
      ctx.db,
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  });
});

describe("Order cancel/expiry (FR-008 lifecycle)", () => {
  it("cancels an unpaid order by its owner", async () => {
    const s = await seed();
    const created = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-cancel",
      correlationId: "corr-1",
    });
    const order = (created as Extract<BuyNowResult, { ok: true }>).order;
    const cancelled = await cancelUnpaidOrder(ctx.db, {
      orderId: order.id,
      customerId: s.customerId,
      correlationId: "corr-1",
    });
    expect(cancelled.ok).toBe(true);
    const status = await sql<{
      status: string;
    }>`select status from "order" where id = ${order.id}`.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("CANCELLED");
  });

  it("does not cancel an order owned by another customer (SR-003 ownership)", async () => {
    const s = await seed();
    const created = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-owned",
      correlationId: "corr-1",
    });
    const order = (created as Extract<BuyNowResult, { ok: true }>).order;
    const otherCustomer = newId();
    await sql`insert into customer (id, status, locale) values (${otherCustomer}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const result = await cancelUnpaidOrder(ctx.db, {
      orderId: order.id,
      customerId: otherCustomer,
      correlationId: "corr-1",
    });
    expect(result.ok).toBe(false);
    const status = await sql<{
      status: string;
    }>`select status from "order" where id = ${order.id}`.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("PENDING_PAYMENT");
  });

  it("expires overdue unpaid orders past their expiry", async () => {
    const s = await seed();
    const created = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy-expire",
      correlationId: "corr-1",
      ttlSeconds: 900,
    });
    const order = (created as Extract<BuyNowResult, { ok: true }>).order;
    // Force expiry into the past.
    await sql`update "order" set expires_at = now() - interval '1 minute' where id = ${order.id}`.execute(
      ctx.db,
    );
    const expired = await expireOverdueOrders(ctx.db, { now: new Date() });
    expect(expired).toBeGreaterThanOrEqual(1);
    const status = await sql<{
      status: string;
    }>`select status from "order" where id = ${order.id}`.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("EXPIRED");
  });
});
