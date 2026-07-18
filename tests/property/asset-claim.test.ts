import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { claimLocalAsset } from "../../src/modules/digital-goods/repository.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T059 — Final-asset concurrency claim (FR-014, SC-006).
 *
 * N concurrent buyers race for a single AVAILABLE local asset of a given
 * variant. Exactly ONE claim must succeed; the rest must fail with a stable
 * OUT_OF_STOCK (or equivalent) code. The asset ends RESERVED/READY for that
 * one order and is never double-allocated. The unique active-fingerprint index
 * and the version-guarded reserve are the exactly-once keys that make this
 * hold under concurrent transactions.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  variantId: string;
  assetId: string;
  fingerprint: string;
  orderIds: string[];
}

async function seedOneAssetManyOrders(buyerCount: number): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const assetId = newId();
  const fingerprint = "fp-" + newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("SECRET-FOR-CLAIM-TEST");

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

  // One AVAILABLE local asset.
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${fingerprint}, 'AVAILABLE')
  `.execute(ctx.db);

  // N paid orders all racing for that one asset.
  const orderIds: string[] = [];
  for (let i = 0; i < buyerCount; i++) {
    const customerId = newId();
    const orderId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status, paid_at)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
        100000, 'P1M', 'CREDENTIAL', 'PAID', now())
    `.execute(ctx.db);
    orderIds.push(orderId);
  }

  return { variantId, assetId, fingerprint, orderIds };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

describe("atomic local asset claim (FR-014 / SC-006)", () => {
  it("exactly one of 20 concurrent buyers claims the final available asset", async () => {
    const BUYERS = 20;
    const f = await seedOneAssetManyOrders(BUYERS);

    // Fire all claims concurrently — each order tries to claim one AVAILABLE asset
    // for the same variant. Exactly one must win.
    const results = await Promise.all(
      f.orderIds.map((orderId) =>
        claimLocalAsset(ctx.db, {
          orderId,
          variantId: f.variantId,
          correlationId: "claim-" + orderId,
        }).then(
          (r) => r,
          (err: unknown) => ({ ok: false as const, error: String(err) }),
        ),
      ),
    );

    const wins = results.filter((r) => r.ok === true);
    const losses = results.filter((r) => r.ok === false);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(BUYERS - 1);

    // The winning claim reserved exactly this asset for that order.
    const winner = wins[0];
    if (!winner || !winner.ok) throw new Error("no winner");
    expect(winner.assetId).toBe(f.assetId);

    const asset = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${f.assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]?.status).toBe("RESERVED");
    expect(asset.rows[0]?.reserved_order_id).toBe(winner.orderId);

    // No second asset exists for this fingerprint (unique active index holds).
    const count = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset
      where fingerprint_hash = ${f.fingerprint}
        and status in ('RESERVED','READY','DELIVERED')
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("a second claim for the same order is a no-op reuse (idempotent)", async () => {
    const f = await seedOneAssetManyOrders(1);
    const orderId = f.orderIds[0]!;
    const first = await claimLocalAsset(ctx.db, {
      orderId,
      variantId: f.variantId,
      correlationId: "c1",
    });
    expect(first.ok).toBe(true);
    const second = await claimLocalAsset(ctx.db, {
      orderId,
      variantId: f.variantId,
      correlationId: "c2",
    });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.assetId).toBe(first.assetId);
    }
    // Still exactly one reserved row.
    const count = await sql<{ count: string }>`
      select count(*)::text as count from digital_asset where reserved_order_id = ${orderId}
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("returns OUT_OF_STOCK when no AVAILABLE asset exists for the variant", async () => {
    // Seed a paid order for a variant with no assets.
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

    const res = await claimLocalAsset(ctx.db, {
      orderId,
      variantId,
      correlationId: "empty",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("OUT_OF_STOCK");
  });
});
