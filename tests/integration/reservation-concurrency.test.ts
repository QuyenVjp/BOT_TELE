import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import { presentPaymentForOrder } from "../../src/modules/payments/service.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T154 — Atomic pre-payment inventory reservation (P0 money-safety).
 *
 * Accepted rule (spec FR-006a / SC-006): the winner is the FIRST transaction that
 * commits an atomic reservation. Every loser gets one typed stock outcome with
 * no Order, no Payment Intent, and no QR.
 *
 * This suite proves, against ONE AVAILABLE asset with 100 concurrent buyers:
 *   - exactly one Order exists,
 *   - exactly one digital_asset is RESERVED and bound to that Order,
 *   - the winner can presentPaymentForOrder and gets exactly one Payment Intent
 *     with a real VietQR payload,
 *   - the 99 losers have no Order, no Payment Intent, and no QR.
 *
 * Requires Docker/Testcontainers. Skipped with an explicit reason when absent.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("atomic pre-payment reservation (T154)", () => {
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
    customerIds: string[];
    assetIds: string[];
  }

  async function seedAssets(variantId: string, count: number): Promise<string[]> {
    const assetIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const assetId = newId();
      assetIds.push(assetId);
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
      `.execute(ctx.db);
    }
    return assetIds;
  }

  async function seedSingleAsset(buyerCount: number): Promise<Seed> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const assetIds: string[] = [];
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
    // Exactly ONE available asset — the contested final unit.
    assetIds.push(...(await seedAssets(variantId, 1)));
    const customerIds: string[] = [];
    for (let i = 0; i < buyerCount; i++) {
      const cid = newId();
      customerIds.push(cid);
      await sql`insert into customer (id, status, locale) values (${cid}, 'ACTIVE', 'vi')`.execute(
        ctx.db,
      );
    }

    return { variantId, price, customerIds, assetIds };
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

  it("100 concurrent buyers → 1 reservation + 1 Payment Intent/QR; 99 clean losers", async () => {
    const buyerCount = 100;
    const seed = await seedSingleAsset(buyerCount);

    const results = await Promise.all(
      seed.customerIds.map((customerId) =>
        buyNow(ctx.db, {
          customerId,
          variantId: seed.variantId,
          expectedPriceVnd: seed.price,
          idempotencyKey: "buy-" + customerId,
          correlationId: "corr-" + customerId.slice(-6),
        }),
      ),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    // Exactly one winner, every loser has a typed stock outcome.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(buyerCount - 1);
    for (const l of losers) {
      expect(l.ok).toBe(false);
      if (!l.ok) {
        expect(["NO_STOCK", "CONTENTION_TIMEOUT", "RESERVATION_LOST"]).toContain(l.code);
      }
    }

    // Exactly one Order row exists in the whole table.
    const orderCount = await sql<{ count: string }>`
      select count(*)::text as count from "order"
    `.execute(ctx.db);
    expect(orderCount.rows[0]?.count).toBe("1");

    // Exactly one asset is RESERVED and bound to the winning order.
    const winner = winners[0];
    if (!winner || !winner.ok) throw new Error("no winner");
    const reserved = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${seed.assetIds[0]}
    `.execute(ctx.db);
    expect(reserved.rows[0]?.status).toBe("RESERVED");
    expect(reserved.rows[0]?.reserved_order_id).toBe(winner.order.id);

    // Winner presents payment → exactly one live intent + real VietQR payload.
    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: winner.order.id,
      merchantAccountId: MERCHANT.merchantAccountId,
      beneficiaryAccountNumber: MERCHANT.beneficiaryAccountNumber,
      bankBin: MERCHANT.bankBin,
      accountName: MERCHANT.accountName,
      bankName: MERCHANT.bankName,
      correlationId: "corr-present-winner",
    });
    expect(presented.ok).toBe(true);
    if (!presented.ok) return;
    expect(presented.presentation.payload.startsWith("0002")).toBe(true);
    expect(presented.presentation.amountVnd).toBe(seed.price);

    // Exactly one Payment Intent exists in the whole table after presentation.
    const intents = await sql<{ count: string; order_id: string }>`
      select count(*)::text as count, min(order_id) as order_id from payment_intent
    `.execute(ctx.db);
    expect(intents.rows[0]?.count).toBe("1");
    expect(intents.rows[0]?.order_id).toBe(winner.order.id);

    // Losers have no Order and no intent — re-assert after presentation so the
    // suite cannot be green with zero intents (false-green trap).
    for (const l of losers) {
      if (l.ok) continue;
      // No loser customer appears on any order.
    }
    const loserOrders = await sql<{ count: string }>`
      select count(*)::text as count from "order"
      where customer_id <> ${winner.order.customerId}
    `.execute(ctx.db);
    expect(loserOrders.rows[0]?.count).toBe("0");
  });

  it("100 concurrent buyers against 100 available assets all reserve unique orders and payment intents", async () => {
    const buyerCount = 100;
    const seed = await seedSingleAsset(buyerCount);
    await seedAssets(seed.variantId, buyerCount - 1);

    const results = await Promise.all(
      seed.customerIds.map((customerId) =>
        buyNow(ctx.db, {
          customerId,
          variantId: seed.variantId,
          expectedPriceVnd: seed.price,
          idempotencyKey: "buy-" + customerId,
          correlationId: "corr-" + customerId.slice(-6),
        }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(buyerCount);

    const presented = await Promise.all(
      winners.map((winner, index) => {
        if (!winner.ok) throw new Error("unexpected loser");
        return presentPaymentForOrder(ctx.db, {
          orderId: winner.order.id,
          merchantAccountId: MERCHANT.merchantAccountId,
          beneficiaryAccountNumber: MERCHANT.beneficiaryAccountNumber,
          bankBin: MERCHANT.bankBin,
          accountName: MERCHANT.accountName,
          bankName: MERCHANT.bankName,
          correlationId: `corr-present-${index}`,
        });
      }),
    );
    expect(presented.every((result) => result.ok)).toBe(true);

    const rows = await sql<{
      orders: string;
      intents: string;
      reserved: string;
      unique_orders: string;
      unique_assets: string;
    }>`
      select
        (select count(*)::text from "order") as orders,
        (select count(*)::text from payment_intent) as intents,
        (select count(*)::text from digital_asset where status = 'RESERVED') as reserved,
        (select count(distinct reserved_order_id)::text from digital_asset where status = 'RESERVED') as unique_orders,
        (select count(distinct id)::text from digital_asset where status = 'RESERVED') as unique_assets
    `.execute(ctx.db);

    expect(rows.rows[0]).toEqual({
      orders: "100",
      intents: "100",
      reserved: "100",
      unique_orders: "100",
      unique_assets: "100",
    });
  });

  it("refuses presentPaymentForOrder for a hand-inserted order without a reservation", async () => {
    // T157 gate: a PENDING_PAYMENT row that skipped BuyNow must not mint a QR.
    const seed = await seedSingleAsset(1);
    const orderId = newId();
    await sql`
      insert into "order"
        (id, order_number, idempotency_key, customer_id, variant_id,
         product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type,
         warranty_days, supplier_policy_snapshot, status, expires_at)
      values
        (${orderId}, ${"ORD-TEST-" + orderId.slice(-6)}, 'hand-1', ${seed.customerIds[0]},
         ${seed.variantId}, 'P', 'V', ${seed.price}, 'P1M', 'CREDENTIAL', 30,
         'LOCAL_ONLY', 'PENDING_PAYMENT', now() + interval '15 minutes')
    `.execute(ctx.db);

    const presented = await presentPaymentForOrder(ctx.db, {
      orderId,
      merchantAccountId: MERCHANT.merchantAccountId,
      beneficiaryAccountNumber: MERCHANT.beneficiaryAccountNumber,
      bankBin: MERCHANT.bankBin,
      accountName: MERCHANT.accountName,
      bankName: MERCHANT.bankName,
      correlationId: "corr-no-reserve",
    });
    expect(presented.ok).toBe(false);
    if (!presented.ok) expect(presented.error).toBe("no active reservation");

    const intents = await sql<{ count: string }>`
      select count(*)::text as count from payment_intent
    `.execute(ctx.db);
    expect(intents.rows[0]?.count).toBe("0");
  });
});
