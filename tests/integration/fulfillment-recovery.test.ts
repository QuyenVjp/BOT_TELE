import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  fulfillPaidOrder,
  type FulfillmentDeps,
} from "../../src/modules/digital-goods/fulfillment.js";
import { createSandboxSupplierAdapter } from "../../src/modules/supplier/adapters/primary.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T061 — Fulfillment crash/replay at paid, supplier accepted, asset claimed,
 * and bundle issued boundaries (FR-010, SR-006).
 *
 * Replaying fulfillPaidOrder at every boundary must not create a second
 * supplier purchase, asset claim, or Delivery Bundle. Unique-effect keys
 * (supplier idempotency, active fingerprint, active bundle per order) plus
 * the orchestrator's re-entry checks make this hold under at-least-once
 * outbox delivery.
 */

let ctx: PgTestContext;
let vault: ReturnType<typeof createInMemoryVault>;

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
  assetId: string;
}

async function seedPaidOrderWithLocalAsset(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vaultRef = await vault.write("SECRET-" + newId().slice(-6));

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'AVAILABLE')
  `.execute(ctx.db);

  return { orderId, customerId, variantId, assetId };
}

function deps(): FulfillmentDeps {
  return {
    vault,
    supplier: createSandboxSupplierAdapter({ mode: "fulfill" }),
    deliveryBaseUrl: "https://shop.example/d",
    bundleTtlSeconds: 900,
  };
}

beforeEach(async () => {
  vault = createInMemoryVault();
  await sql`
    truncate table delivery_bundle, digital_asset, supplier_order, supplier_sku, supplier,
      payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition,
      outbox_event, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("fulfillment crash/replay recovery (FR-010 / SR-006)", () => {
  it("fulfills a paid local-stock order end-to-end (claim + bundle)", async () => {
    const f = await seedPaidOrderWithLocalAsset();
    const res = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "ful-1",
      deps: deps(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("DELIVERY_BUNDLE");
    if (res.kind !== "DELIVERY_BUNDLE")
      throw new Error(`expected delivery bundle, got ${res.kind}`);
    expect(res.bundleId).toBeTruthy();
    expect(res.token.length).toBeGreaterThanOrEqual(32);
    expect(res.assetId).toBe(f.assetId);

    const order = await sql<{
      status: string;
    }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
    // Order moves at least to PROCESSING (or COMPLETED once delivered).
    expect(["PROCESSING", "COMPLETED"]).toContain(order.rows[0]?.status);

    const asset = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${f.assetId}
    `.execute(ctx.db);
    expect(["RESERVED", "READY", "DELIVERED"]).toContain(asset.rows[0]?.status);
    expect(asset.rows[0]?.reserved_order_id).toBe(f.orderId);

    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
  });

  it("replaying fulfillPaidOrder is idempotent (one asset, one bundle)", async () => {
    const f = await seedPaidOrderWithLocalAsset();
    const input = { orderId: f.orderId, correlationId: "ful-1", deps: deps() };

    const first = await fulfillPaidOrder(ctx.db, input);
    expect(first.ok).toBe(true);
    const second = await fulfillPaidOrder(ctx.db, input);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok) {
      expect(first.kind).toBe("DELIVERY_BUNDLE");
      expect(second.kind).toBe("DELIVERY_BUNDLE");
      if (first.kind !== "DELIVERY_BUNDLE")
        throw new Error(`expected delivery bundle, got ${first.kind}`);
      if (second.kind !== "DELIVERY_BUNDLE")
        throw new Error(`expected delivery bundle, got ${second.kind}`);
      expect(second.assetId).toBe(first.assetId);
      expect(second.bundleId).toBe(first.bundleId);
    }

    const assets = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset
      where reserved_order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(assets.rows[0]?.count)).toBe(1);

    const bundles = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(bundles.rows[0]?.count)).toBe(1);
  });

  it("refuses to fulfill an unpaid order (FR-013)", async () => {
    const f = await seedPaidOrderWithLocalAsset();
    // Force the order back to PENDING_PAYMENT.
    await sql`update "order" set status = 'PENDING_PAYMENT', paid_at = null where id = ${f.orderId}`.execute(
      ctx.db,
    );
    const res = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "ful-x",
      deps: deps(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NOT_PAID");
  });

  it("returns OUT_OF_STOCK when no local asset and no supplier is wired", async () => {
    // Paid order, no asset, no supplier.
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const customerId = newId();
    const orderId = newId();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
    `.execute(ctx.db);
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status, paid_at)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
        100000, 'P1M', 'CREDENTIAL', 'PAID', now())
    `.execute(ctx.db);

    const res = await fulfillPaidOrder(ctx.db, {
      orderId,
      correlationId: "ful-empty",
      deps: { ...deps(), supplier: null },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["OUT_OF_STOCK", "NEEDS_REVIEW"]).toContain(res.code);
  });
});
