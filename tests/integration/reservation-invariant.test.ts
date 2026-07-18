import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { presentPaymentForOrder } from "../../src/modules/payments/service.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T156/T157 — DB invariant: one active reservation per Order, and payment
 * presentation only accepts a VALID reservation (orderId + variantId +
 * RESERVED + reserved_until > now; never DELIVERED / expired).
 *
 * Requires Docker/Testcontainers.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("reservation invariant + payment guard (T156/T157)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  interface Seed {
    variantId: string;
    otherVariantId: string;
    price: number;
    customerId: string;
    orderId: string;
    assetA: string;
    assetB: string;
  }

  async function seed(): Promise<Seed> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const otherVariantId = newId();
    const customerId = newId();
    const orderId = newId();
    const assetA = newId();
    const assetB = newId();
    const price = 150000;
    const slug = categoryId.slice(-8);

    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
      ctx.db,
    );
    for (const vid of [variantId, otherVariantId]) {
      await sql`
        insert into product_variant
          (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
           stock_policy, resale_evidence_id, is_active, sort_order)
        values
          (${vid}, ${productId}, ${"SKU-" + vid}, 'V', ${price}, 'P1M', 'CREDENTIAL', 30,
           'LOCAL_ONLY', 'RES-1', true, 1)
      `.execute(ctx.db);
    }
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into "order"
        (id, order_number, idempotency_key, customer_id, variant_id,
         product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type,
         warranty_days, supplier_policy_snapshot, status, expires_at)
      values
        (${orderId}, ${"ORD-" + orderId.slice(-8)}, 'inv-1', ${customerId}, ${variantId},
         'P', 'V', ${price}, 'P1M', 'CREDENTIAL', 30, 'LOCAL_ONLY', 'PENDING_PAYMENT',
         now() + interval '15 minutes')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values
        (${assetA}, ${variantId}, 'LOCAL', ${"vault:" + assetA}, ${"fp-" + assetA}, 'AVAILABLE'),
        (${assetB}, ${variantId}, 'LOCAL', ${"vault:" + assetB}, ${"fp-" + assetB}, 'AVAILABLE')
    `.execute(ctx.db);

    return { variantId, otherVariantId, price, customerId, orderId, assetA, assetB };
  }

  beforeEach(async () => {
    await sql`
      truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
        bank_transaction, payment_intent, order_transition, "order",
        product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  const MERCHANT = {
    merchantAccountId: "0123456789",
    beneficiaryAccountNumber: "9876543210",
    bankBin: "970422",
    accountName: "SHOP DIGITAL MVP",
    bankName: "MB Bank",
  };

  it("rejects a second active reservation for the same order at the DB layer", async () => {
    const s = await seed();
    // First reservation succeeds.
    await sql`
      update digital_asset
      set status = 'RESERVED', reserved_order_id = ${s.orderId},
          reserved_until = now() + interval '15 minutes'
      where id = ${s.assetA}
    `.execute(ctx.db);

    // Second reservation for the SAME order must violate the unique partial index.
    let failed = false;
    try {
      await sql`
        update digital_asset
        set status = 'RESERVED', reserved_order_id = ${s.orderId},
            reserved_until = now() + interval '15 minutes'
        where id = ${s.assetB}
      `.execute(ctx.db);
    } catch (err) {
      failed = true;
      expect(
        typeof err === "object" && err !== null && (err as { code?: string }).code === "23505",
      ).toBe(true);
    }
    expect(failed).toBe(true);

    const reservedCount = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset
      where reserved_order_id = ${s.orderId} and status = 'RESERVED'
    `.execute(ctx.db);
    expect(reservedCount.rows[0]?.count).toBe("1");
  });

  it("refuses presentPayment when reserved_until has passed", async () => {
    const s = await seed();
    await sql`
      update digital_asset
      set status = 'RESERVED', reserved_order_id = ${s.orderId},
          reserved_until = now() - interval '1 minute'
      where id = ${s.assetA}
    `.execute(ctx.db);

    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: s.orderId,
      ...MERCHANT,
      correlationId: "corr-expired-reserve",
    });
    expect(presented.ok).toBe(false);
    if (!presented.ok) expect(presented.error).toBe("no active reservation");
  });

  it("refuses presentPayment when the asset is DELIVERED (not a pre-payment hold)", async () => {
    const s = await seed();
    await sql`
      update digital_asset
      set status = 'DELIVERED', reserved_order_id = ${s.orderId},
          reserved_until = now() + interval '15 minutes',
          delivered_order_id = ${s.orderId}
      where id = ${s.assetA}
    `.execute(ctx.db);

    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: s.orderId,
      ...MERCHANT,
      correlationId: "corr-delivered",
    });
    expect(presented.ok).toBe(false);
    if (!presented.ok) expect(presented.error).toBe("no active reservation");
  });

  it("refuses presentPayment when reserved asset is for a different variant", async () => {
    const s = await seed();
    // Bind a reservation under the OTHER variant id — same order, wrong variant.
    await sql`
      update digital_asset
      set status = 'RESERVED', reserved_order_id = ${s.orderId},
          reserved_until = now() + interval '15 minutes',
          variant_id = ${s.otherVariantId}
      where id = ${s.assetA}
    `.execute(ctx.db);

    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: s.orderId,
      ...MERCHANT,
      correlationId: "corr-wrong-variant",
    });
    expect(presented.ok).toBe(false);
    if (!presented.ok) expect(presented.error).toBe("no active reservation");
  });

  it("refuses presentPayment when the order itself is past expires_at", async () => {
    const s = await seed();
    await sql`
      update digital_asset
      set status = 'RESERVED', reserved_order_id = ${s.orderId},
          reserved_until = now() + interval '15 minutes'
      where id = ${s.assetA}
    `.execute(ctx.db);
    await sql`
      update "order" set expires_at = now() - interval '1 minute' where id = ${s.orderId}
    `.execute(ctx.db);

    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: s.orderId,
      ...MERCHANT,
      correlationId: "corr-order-expired",
    });
    expect(presented.ok).toBe(false);
    if (!presented.ok) expect(presented.error).toBe("order expired");
  });
});
