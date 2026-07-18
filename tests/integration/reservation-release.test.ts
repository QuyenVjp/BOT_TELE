import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  buyNow,
  cancelUnpaidOrder,
  expireOverdueOrders,
} from "../../src/modules/commerce/buy-now.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T155 — Direct cancel/expiry reservation release (FR-006c, demoted scope).
 *
 * A pre-payment reservation holds the one final unit. When the Order is
 * cancelled or expired via the direct command/helper, the unit MUST return to
 * AVAILABLE in the same atomic step that voids the Payment Intent, so the next
 * buyer can reserve it.
 *
 * Scope note (follow-up review P1): this suite only proves the *direct*
 * cancelUnpaidOrder / expireOverdueOrders release paths. Bounded crash-recovery
 * (SKIP LOCKED batch claim, per-row isolation, backlog telemetry) is owned by
 * T167/T168 and is NOT claimed green here.
 *
 * Requires Docker/Testcontainers. Skipped with an explicit reason when absent.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("reservation release (T155)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  interface Seed {
    variantId: string;
    price: number;
    buyerA: string;
    buyerB: string;
    assetId: string;
  }

  async function seedSingleAsset(): Promise<Seed> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const assetId = newId();
    const buyerA = newId();
    const buyerB = newId();
    const price = 150000;
    const slug = categoryId.slice(-8);

    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order)
      values
        (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${price}, 'P1M', 'CREDENTIAL', 30,
         'LOCAL_ONLY', 'RES-1', true, 1)
    `.execute(ctx.db);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
    for (const cid of [buyerA, buyerB]) {
      await sql`insert into customer (id, status, locale) values (${cid}, 'ACTIVE', 'vi')`.execute(
        ctx.db,
      );
    }

    return { variantId, price, buyerA, buyerB, assetId };
  }

  beforeEach(async () => {
    await sql`
      truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
        bank_transaction, payment_intent, order_transition, "order",
        product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  async function reserve(seed: Seed, customerId: string, key: string) {
    return buyNow(ctx.db, {
      customerId,
      variantId: seed.variantId,
      expectedPriceVnd: seed.price,
      idempotencyKey: key,
      correlationId: "corr-" + key,
    });
  }

  it("returns the asset to AVAILABLE on cancel so the next buyer can reserve it", async () => {
    const seed = await seedSingleAsset();

    const first = await reserve(seed, seed.buyerA, "a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Before cancel, buyer B cannot get the (only) unit.
    const blocked = await reserve(seed, seed.buyerB, "b1");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("NO_STOCK");

    // Cancel releases the reservation atomically.
    const cancelled = await cancelUnpaidOrder(ctx.db, {
      orderId: first.order.id,
      customerId: seed.buyerA,
      correlationId: "cancel-a",
    });
    expect(cancelled.ok).toBe(true);

    const afterCancel = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${seed.assetId}
    `.execute(ctx.db);
    expect(afterCancel.rows[0]?.status).toBe("AVAILABLE");
    expect(afterCancel.rows[0]?.reserved_order_id).toBeNull();

    // Now buyer B can reserve the freed unit.
    const second = await reserve(seed, seed.buyerB, "b2");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const reReserved = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${seed.assetId}
    `.execute(ctx.db);
    expect(reReserved.rows[0]?.status).toBe("RESERVED");
    expect(reReserved.rows[0]?.reserved_order_id).toBe(second.order.id);
  });

  it("releases the reservation when expireOverdueOrders is invoked directly (bounded job = T167/T168)", async () => {
    const seed = await seedSingleAsset();

    const first = await reserve(seed, seed.buyerA, "a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Force the order past its expiry.
    await sql`update "order" set expires_at = now() - interval '1 minute' where id = ${first.order.id}`.execute(
      ctx.db,
    );

    const expired = await expireOverdueOrders(ctx.db, { now: new Date() });
    expect(expired).toBeGreaterThanOrEqual(1);

    const afterExpiry = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${seed.assetId}
    `.execute(ctx.db);
    expect(afterExpiry.rows[0]?.status).toBe("AVAILABLE");
    expect(afterExpiry.rows[0]?.reserved_order_id).toBeNull();

    const orderStatus = await sql<{ status: string }>`
      select status from "order" where id = ${first.order.id}
    `.execute(ctx.db);
    expect(orderStatus.rows[0]?.status).toBe("EXPIRED");
  });
});
