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
 * T156 — TOCTOU between revalidation and reservation (follow-up review P0).
 *
 * The prior implementation read price/active/stock_policy/resale OUTSIDE the
 * transaction, then reserved inside a later transaction against a stale snapshot.
 * An admin who changed price, paused the SKU, or flipped SUPPLIER_ONLY→LOCAL_ONLY
 * in that window could produce an Order that either charged the wrong price or
 * skipped reservation while the payment guard still allowed a QR.
 *
 * The fix locks + re-reads the variant row INSIDE the Buy Now transaction. These
 * tests assert the committed decision reflects the live row, and that an Order is
 * never created on a rejected revalidation.
 *
 * Requires Docker/Testcontainers. Skipped with an explicit reason when absent.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("Buy Now revalidation is transaction-consistent (T156)", () => {
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
  }

  async function seed(policy = "LOCAL_ONLY", withAsset = true): Promise<Seed> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const customerId = newId();
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
         ${policy}, 'RES-1', true, 1)
    `.execute(ctx.db);
    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values ('RES-1', ${variantId}, 'OWNER_ATTESTATION', 'TEST-REF', 'fixture publication evidence', 'test')
    `.execute(ctx.db);
    await sql`
      update product_variant
         set publication_evidence_id = resale_evidence_id,
             publication_product_version = 1,
             publication_variant_version = 1,
             published_at = now(),
             published_by = 'test'
       where id = ${variantId}
    `.execute(ctx.db);
    if (withAsset) {
      const assetId = newId();
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
      `.execute(ctx.db);
    }
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    return { variantId, price, customerId };
  }

  beforeEach(async () => {
    await sql`
      truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
        bank_transaction, payment_intent, order_transition, "order",
        product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  it("rejects a stale price the moment the admin changes it (no Order created)", async () => {
    const s = await seed();
    // Admin raises the price after the customer saw 150000.
    await sql`update product_variant set price_vnd = 175000 where id = ${s.variantId}`.execute(
      ctx.db,
    );

    const res = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price, // stale 150000
      idempotencyKey: "k1",
      correlationId: "c1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PRICE_CHANGED");

    const orders = await sql<{
      count: string;
    }>`select count(*)::text as count from "order"`.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe("0");
    // The one asset is untouched.
    const reserved = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where status = 'RESERVED'
    `.execute(ctx.db);
    expect(reserved.rows[0]?.count).toBe("0");
  });

  it("rejects a paused SKU without creating an Order or reservation", async () => {
    const s = await seed();
    await sql`update product_variant set stock_policy = 'PAUSED' where id = ${s.variantId}`.execute(
      ctx.db,
    );

    const res = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "k2",
      correlationId: "c2",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_STOCK");

    const orders = await sql<{
      count: string;
    }>`select count(*)::text as count from "order"`.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe("0");
  });

  it("a LOCAL_ONLY variant with no available asset never yields an Order or QR-eligible state", async () => {
    const s = await seed("LOCAL_ONLY", false); // no asset seeded

    const res = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "k3",
      correlationId: "c3",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_STOCK");

    const orders = await sql<{
      count: string;
    }>`select count(*)::text as count from "order"`.execute(ctx.db);
    expect(orders.rows[0]?.count).toBe("0");
  });
});
