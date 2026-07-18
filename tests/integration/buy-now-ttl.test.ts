import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table digital_asset, order_transition, "order", product_variant, product, category,
      customer cascade
  `.execute(ctx.db);
});

async function seed() {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const assetId = newId();
  const price = 100000;
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${price}, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
  `.execute(ctx.db);
  return { customerId, variantId, price };
}

describe("BuyNow TTL normalization", () => {
  const cases = [
    ["NaN", Number.NaN, 900],
    ["Infinity", Number.POSITIVE_INFINITY, 900],
    ["-Infinity", Number.NEGATIVE_INFINITY, 900],
    ["negative", -30, 60],
    ["too large", 999999, 3600],
    ["fractional", 125.9, 125],
  ] as const;

  for (const [name, inputTtl, expectedSeconds] of cases) {
    it(`normalizes ${name} to a finite bounded TTL`, async () => {
      const s = await seed();
      const result = await buyNow(ctx.db, {
        customerId: s.customerId,
        variantId: s.variantId,
        expectedPriceVnd: s.price,
        idempotencyKey: `ttl-${name}-${newId()}`,
        correlationId: `ttl-${name}`,
        ttlSeconds: inputTtl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = await sql<{ ttl_seconds: number }>`
        select extract(epoch from (expires_at - created_at))::float8 as ttl_seconds
        from "order" where id = ${result.order.id}
      `.execute(ctx.db);
      expect(Number.isFinite(row.rows[0]?.ttl_seconds)).toBe(true);
      expect(row.rows[0]?.ttl_seconds).toBeGreaterThan(expectedSeconds - 2);
      expect(row.rows[0]?.ttl_seconds).toBeLessThanOrEqual(expectedSeconds + 1);
    });
  }
});
