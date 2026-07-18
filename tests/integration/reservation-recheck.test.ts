import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T156 — SKIP LOCKED recheck after lock-holder rollback (data-model rule).
 *
 * If the only AVAILABLE asset is locked by a transaction that later rolls back,
 * a single naive SKIP LOCKED attempt would return null (false OOS) while the
 * unit is still free. The reserve path rechecks when AVAILABLE rows still exist
 * but are all currently locked, then retries a bounded number of times.
 *
 * Requires Docker/Testcontainers.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("SKIP LOCKED recheck on lock-holder rollback (T156)", () => {
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
    customerId: string;
    assetId: string;
  }

  async function seed(): Promise<Seed> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const customerId = newId();
    const assetId = newId();
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
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    return { variantId, price, customerId, assetId };
  }

  beforeEach(async () => {
    await sql`
      truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
        bank_transaction, payment_intent, order_transition, "order",
        product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  it("succeeds when the concurrent lock-holder rolls back (no false OOS)", async () => {
    const s = await seed();

    // Hold a row lock on the only AVAILABLE asset in a separate transaction,
    // then roll it back mid-flight so Buy Now's bounded recheck can win the
    // freed unit instead of falsely reporting out-of-stock.
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const holdPromise = ctx.db.transaction().execute(async (trx) => {
      await sql`
        select id from digital_asset
        where id = ${s.assetId} and status = 'AVAILABLE'
        for update
      `.execute(trx);
      // Hold until the test signals release (then roll back by throwing).
      await lockHeld;
      throw Object.assign(new Error("rollback-holder"), { code: "ROLLBACK_HOLDER" });
    });
    // Swallow the intentional rollback.
    const holdDone = holdPromise.catch((err: unknown) => {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "ROLLBACK_HOLDER"
      ) {
        return;
      }
      throw err;
    });

    // Give the holder a moment to acquire the lock before Buy Now starts.
    await new Promise((r) => setTimeout(r, 50));

    // Start Buy Now while the holder still owns the row. With recheck it should
    // wait/retry rather than immediately return OUT_OF_STOCK.
    const buyPromise = buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "recheck-1",
      correlationId: "corr-recheck",
    });

    // After Buy Now has had a chance to hit the contended path, roll the holder
    // back so the asset becomes free again.
    await new Promise((r) => setTimeout(r, 80));
    releaseLock();
    await holdDone;

    const res = await buyPromise;
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const reserved = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${s.assetId}
    `.execute(ctx.db);
    expect(reserved.rows[0]?.status).toBe("RESERVED");
    expect(reserved.rows[0]?.reserved_order_id).toBe(res.order.id);
  }, 30_000);
});
