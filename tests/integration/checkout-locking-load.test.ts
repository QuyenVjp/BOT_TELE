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
    truncate table outbox_event, payment_intent, digital_asset, order_transition, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
  await sql`drop function if exists test_slow_order_insert() cascade`.execute(ctx.db);
  await sql`drop function if exists test_hold_first_checkout() cascade`.execute(ctx.db);
});

interface VariantSeed {
  customerIds: string[];
  categoryId: string;
  variantA: string;
  variantB: string;
  assetA: string;
  assetB: string;
  price: number;
}

async function seedTwoVariants(customerCount = 16): Promise<VariantSeed> {
  const categoryId = newId();
  const productA = newId();
  const productB = newId();
  const variantA = newId();
  const variantB = newId();
  const assetA = newId();
  const assetB = newId();
  const price = 150000;
  const slug = categoryId.slice(-8);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order) values
      (${productA}, ${categoryId}, 'P-A', ${"a-" + slug}, true, 1),
      (${productB}, ${categoryId}, 'P-B', ${"b-" + slug}, true, 2)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, sort_order)
    values
      (${variantA}, ${productA}, ${"SKU-A-" + variantA}, 'A', ${price}, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-A', 1),
      (${variantB}, ${productB}, ${"SKU-B-" + variantB}, 'B', ${price}, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-B', 2)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetA}, ${variantA}, 'LOCAL', ${"vault:" + assetA}, ${"fp-" + assetA}, 'AVAILABLE'),
      (${assetB}, ${variantB}, 'LOCAL', ${"vault:" + assetB}, ${"fp-" + assetB}, 'AVAILABLE')
  `.execute(ctx.db);

  const customerIds: string[] = [];
  for (let i = 0; i < customerCount; i++) {
    const customerId = newId();
    customerIds.push(customerId);
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
  }
  return { customerIds, categoryId, variantA, variantB, assetA, assetB, price };
}

function checkout(s: VariantSeed, customerId: string, variantId: string, suffix: string) {
  return buyNow(ctx.db, {
    customerId,
    variantId,
    expectedPriceVnd: s.price,
    idempotencyKey: `lock-${suffix}-${customerId}`,
    correlationId: `lock-${suffix}`,
  });
}

describe("checkout locking and bounded load", () => {
  it("a contended buyer does not serialize a buyer of another variant in the same category", async () => {
    const s = await seedTwoVariants(2);
    const blocker = await ctx.handle.pool.connect();
    try {
      await sql`
        create function test_hold_first_checkout() returns trigger language plpgsql as $$
        begin
          if new.idempotency_key like 'lock-a-%' then
            perform pg_advisory_xact_lock(742001);
          end if;
          return new;
        end $$
      `.execute(ctx.db);
      await sql`
        create trigger test_hold_first_checkout_trigger before insert on "order"
        for each row execute function test_hold_first_checkout()
      `.execute(ctx.db);
      await blocker.query("select pg_advisory_lock(742001)");

      const buyerA = checkout(s, s.customerIds[0]!, s.variantA, "a");
      let firstBuyerWaiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await sql<{ waiting: number }>`
          select count(*)::int as waiting
          from pg_locks
          where locktype = 'advisory' and not granted
        `.execute(ctx.db);
        if ((waiting.rows[0]?.waiting ?? 0) > 0) {
          firstBuyerWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const buyerB = checkout(s, s.customerIds[1]!, s.variantB, "b");

      const earlyB = await Promise.race([
        buyerB,
        new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 5000)),
      ]);
      await blocker.query("select pg_advisory_unlock(742001)");
      const [resultA, resultB] = await Promise.all([buyerA, buyerB]);
      expect(firstBuyerWaiting).toBe(true);
      expect(earlyB).not.toBe("TIMED_OUT");
      expect(resultB.ok).toBe(true);
      expect(resultA.ok).toBe(true);
    } finally {
      await blocker.query("select pg_advisory_unlock_all()").catch(() => undefined);
      blocker.release();
    }
  }, 15_000);

  it("still serializes an admin category deactivate while checkout holds shared row locks", async () => {
    const s = await seedTwoVariants(1);
    await sql`
      create function test_slow_order_insert() returns trigger language plpgsql as $$
      begin
        perform pg_sleep(0.25);
        return new;
      end $$
    `.execute(ctx.db);
    await sql`
      create trigger test_slow_order_insert_trigger before insert on "order"
      for each row execute function test_slow_order_insert()
    `.execute(ctx.db);

    const buyer = checkout(s, s.customerIds[0]!, s.variantA, "admin-lock");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const adminUpdate =
      sql`update category set is_active = false where id = ${s.categoryId}`.execute(ctx.db);

    const earlyAdmin = await Promise.race([
      adminUpdate.then(() => "UPDATED" as const),
      new Promise<"WAITING">((resolve) => setTimeout(() => resolve("WAITING"), 100)),
    ]);
    expect(earlyAdmin).toBe("WAITING");
    expect((await buyer).ok).toBe(true);
    await adminUpdate;
  });

  it("records bounded contention p95, pool occupancy, typed outcomes, and zero orphans", async () => {
    const s = await seedTwoVariants(12);
    const blocker = await ctx.handle.pool.connect();
    let peakPoolOccupancy = 0;
    try {
      await blocker.query("begin");
      await blocker.query("select id from digital_asset where id = any($1::text[]) for update", [
        [s.assetA, s.assetB],
      ]);

      const monitor = setInterval(() => {
        peakPoolOccupancy = Math.max(
          peakPoolOccupancy,
          ctx.handle.pool.totalCount - ctx.handle.pool.idleCount,
        );
      }, 5);
      const started = performance.now();
      const samples = await Promise.all(
        s.customerIds.slice(0, 12).map(async (customerId, index) => {
          const at = performance.now();
          const result = await checkout(
            s,
            customerId,
            index % 2 === 0 ? s.variantA : s.variantB,
            `load-${index}`,
          );
          return { result, durationMs: performance.now() - at };
        }),
      );
      clearInterval(monitor);

      const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? performance.now() - started;
      const codes = samples.map((sample) => (sample.result.ok ? "OK" : sample.result.code));
      expect(samples.every((sample) => !sample.result.ok)).toBe(true);
      expect(new Set(codes)).toEqual(new Set(["CONTENTION_TIMEOUT"]));
      expect(p95).toBeLessThan(8000);
      expect(peakPoolOccupancy).toBeGreaterThan(0);
      expect(peakPoolOccupancy).toBeLessThanOrEqual(10);

      const orphans = await sql<{ orders_without_hold: number; intents_without_hold: number }>`
        select
          (select count(*)::int from "order" o where not exists (
            select 1 from digital_asset a
            where a.reserved_order_id = o.id and a.status in ('RESERVED','READY')
          )) as orders_without_hold,
          (select count(*)::int from payment_intent pi where not exists (
            select 1 from digital_asset a
            where a.reserved_order_id = pi.order_id and a.status in ('RESERVED','READY')
          )) as intents_without_hold
      `.execute(ctx.db);
      expect(orphans.rows[0]).toEqual({ orders_without_hold: 0, intents_without_hold: 0 });
      console.warn(
        `[checkout-load] p95=${p95.toFixed(1)}ms peakPoolOccupancy=${peakPoolOccupancy}/10 outcomes=${codes.join(",")}`,
      );
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);
});
