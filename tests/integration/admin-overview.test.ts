import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { getAdminOverview, vietnamDayStart } from "../../src/modules/admin/overview.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Admin overview (goal §71 summary block, §136): real trade only.
 *
 * Test and canary inventory must never inflate the owner's dashboard, and the Vietnam day
 * boundary must come from the injected clock rather than the database session timezone.
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
  realVariantId: string;
  testVariantId: string;
}

async function seed(): Promise<Seed> {
  const customerId = newId();
  const categoryId = newId();
  const realProductId = newId();
  const realVariantId = newId();
  const testProductId = newId();
  const testVariantId = newId();
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${realProductId}, ${categoryId}, 'Claude Pro', ${slug + "a"}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, low_stock_threshold)
    values (${realVariantId}, ${realProductId}, ${"SKU-" + realVariantId}, '1 tháng', 199000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', 5)
  `.execute(ctx.db);
  for (let i = 0; i < 2; i++) {
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${realVariantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  // A test product with plenty of stock must not count anywhere.
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test)
    values (${testProductId}, ${categoryId}, '🧪 Test', ${slug + "t"}, true, 2, true)
  `.execute(ctx.db);
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, low_stock_threshold)
    values (${testVariantId}, ${testProductId}, ${"SKU-" + testVariantId}, '1 tháng', 2000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-T', 5)
  `.execute(ctx.db);
  for (let i = 0; i < 50; i++) {
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${testVariantId}, 'LOCAL', ${"vault:" + assetId}, ${"fpt-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return { customerId, realVariantId, testVariantId };
}

async function addOrder(
  seedRow: Seed,
  input: {
    variantId?: string;
    status: string;
    priceVnd: number;
    createdAt: Date;
    completedAt?: Date | null;
    fulfillmentType?: string;
  },
): Promise<string> {
  const id = newId();
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, expires_at, created_at, completed_at, fulfillment_type)
    values (${id}, ${"ORD-" + id.slice(-10)}, ${seedRow.customerId},
      ${input.variantId ?? seedRow.realVariantId}, 'Claude Pro', '1 tháng', ${input.priceVnd}, 'P1M',
      'CREDENTIAL', ${input.status}, ${new Date(input.createdAt.getTime() + 900_000).toISOString()},
      ${input.createdAt.toISOString()}, ${input.completedAt ? input.completedAt.toISOString() : null},
      ${input.fulfillmentType ?? "STOCK_ACCOUNT"})
  `.execute(ctx.db);
  return id;
}

beforeEach(async () => {
  await sql`truncate table test_customer_allowlist, support_ticket, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("vietnamDayStart", () => {
  it("returns midnight in Vietnam, not in the server timezone", () => {
    // 2026-09-10T18:00Z is 2026-09-11 01:00 in Vietnam, so the VN day starts at 2026-09-10T17:00Z.
    expect(vietnamDayStart(new Date("2026-09-10T18:00:00.000Z")).toISOString()).toBe(
      "2026-09-10T17:00:00.000Z",
    );
    expect(vietnamDayStart(new Date("2026-09-10T16:59:59.000Z")).toISOString()).toBe(
      "2026-09-09T17:00:00.000Z",
    );
  });
});

describe("admin overview", () => {
  it("counts only real trade, never test inventory", async () => {
    const seedRow = await seed();
    const now = new Date("2026-09-10T18:00:00.000Z"); // VN 11/09 01:00
    const todayVn = new Date("2026-09-10T18:30:00.000Z");

    await addOrder(seedRow, {
      status: "COMPLETED",
      priceVnd: 199000,
      createdAt: todayVn,
      completedAt: todayVn,
    });
    await addOrder(seedRow, { status: "PENDING_PAYMENT", priceVnd: 199000, createdAt: todayVn });
    await addOrder(seedRow, {
      status: "PAYMENT_NEEDS_REVIEW",
      priceVnd: 199000,
      createdAt: todayVn,
    });
    // A completed TEST order with an identical price must not move any number.
    await addOrder(seedRow, {
      variantId: seedRow.testVariantId,
      status: "COMPLETED",
      priceVnd: 199000,
      createdAt: todayVn,
      completedAt: todayVn,
    });
    // Yesterday (VN) must not count as today.
    await addOrder(seedRow, {
      status: "COMPLETED",
      priceVnd: 500000,
      createdAt: new Date("2026-09-09T10:00:00.000Z"),
      completedAt: new Date("2026-09-09T10:05:00.000Z"),
    });

    const overview = await getAdminOverview(ctx.db, now);

    expect(overview.revenueTodayVnd).toBe(199000n);
    expect(overview.ordersToday).toBe(3);
    expect(overview.awaitingAction).toBe(2);
    expect(overview.paymentsNeedingReview).toBe(1);
  });

  it("flags a sellable variant at or below its threshold and ignores test stock", async () => {
    await seed();
    const overview = await getAdminOverview(ctx.db, new Date("2026-09-10T04:00:00.000Z"));
    // The real variant holds 2 units against a threshold of 5; the test variant holds 50.
    expect(overview.lowStockVariants).toBe(1);
  });

  it("does not count manual-service digital assets as low stock", async () => {
    const seedRow = await seed();
    await sql`update product_variant set fulfillment_type = 'MANUAL_FULFILLMENT' where id = ${seedRow.realVariantId}`.execute(
      ctx.db,
    );

    const overview = await getAdminOverview(ctx.db, new Date("2026-09-10T04:00:00.000Z"));

    expect(overview.lowStockVariants).toBe(0);
  });

  it("counts only verified paid real manual orders with open tasks", async () => {
    const seedRow = await seed();
    const now = new Date("2026-09-10T18:00:00.000Z");
    const realPaidOrderId = await addOrder(seedRow, {
      status: "PROCESSING",
      priceVnd: 199000,
      createdAt: now,
      fulfillmentType: "MANUAL_FULFILLMENT",
    });
    const realUnpaidOrderId = await addOrder(seedRow, {
      status: "PROCESSING",
      priceVnd: 199000,
      createdAt: now,
      fulfillmentType: "MANUAL_FULFILLMENT",
    });
    const testPaidOrderId = await addOrder(seedRow, {
      variantId: seedRow.testVariantId,
      status: "PROCESSING",
      priceVnd: 199000,
      createdAt: now,
      fulfillmentType: "MANUAL_FULFILLMENT",
    });

    for (const [orderId, variantId] of [
      [realPaidOrderId, seedRow.realVariantId],
      [realUnpaidOrderId, seedRow.realVariantId],
      [testPaidOrderId, seedRow.testVariantId],
    ]) {
      await sql`
        insert into manual_fulfillment_task
          (id, order_id, customer_id, variant_id, fulfillment_type, instructions, status)
        values (${newId()}, ${orderId}, ${seedRow.customerId}, ${variantId},
          'MANUAL_FULFILLMENT', 'Owner fulfills privately', 'OPEN')
      `.execute(ctx.db);
    }

    for (const [orderId, paymentSuffix] of [
      [realPaidOrderId, "real"],
      [testPaidOrderId, "test"],
    ]) {
      const paymentIntentId = newId();
      const bankTransactionId = newId();
      await sql`
        insert into payment_intent
          (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at, settled_at)
        values (${paymentIntentId}, ${orderId}, 'SUCCEEDED', 199000, 'test-account',
          ${"MANUAL-" + paymentSuffix}, ${new Date(now.getTime() + 900_000).toISOString()},
          ${now.toISOString()})
      `.execute(ctx.db);
      await sql`
        insert into bank_transaction
          (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
           transacted_at, raw_hash, signature_status, schema_version)
        values (${bankTransactionId}, 'sepay', ${"txn-" + paymentSuffix}, 'IN', 'test-account',
          199000, ${now.toISOString()}, ${"hash-" + paymentSuffix}, 'VERIFIED', '1.1.0')
      `.execute(ctx.db);
      await sql`
        insert into payment_allocation
          (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status, decision_code, correlation_id)
        values (${newId()}, ${bankTransactionId}, ${paymentIntentId}, 199000,
          'SETTLED', 'EXACT_AMOUNT', ${"manual-overview-" + paymentSuffix})
      `.execute(ctx.db);
    }

    const walletOrderId = await addOrder(seedRow, {
      status: "PROCESSING",
      priceVnd: 199000,
      createdAt: now,
      fulfillmentType: "MANUAL_FULFILLMENT",
    });
    await sql`
      insert into manual_fulfillment_task
        (id, order_id, customer_id, variant_id, fulfillment_type, instructions, status)
      values (${newId()}, ${walletOrderId}, ${seedRow.customerId}, ${seedRow.realVariantId},
        'MANUAL_FULFILLMENT', 'Owner fulfills privately', 'OPEN')
    `.execute(ctx.db);
    const walletLedger = createWalletLedgerService(ctx.db);
    const topup = await walletLedger.credit({
      customerId: seedRow.customerId,
      amountVnd: 199000n,
      idempotencyKey: "topup:manual-overview-fixture",
      correlationId: "manual-overview-fixture-topup",
      reason: "TEST_FIXTURE",
    });
    expect(topup.ok).toBe(true);
    const purchase = await walletLedger.debit({
      customerId: seedRow.customerId,
      amountVnd: 199000n,
      idempotencyKey: `purchase:${walletOrderId}:manual-overview-fixture`,
      correlationId: "manual-overview-fixture-purchase",
      reason: "TEST_FIXTURE",
    });
    expect(purchase.ok).toBe(true);

    const overview = await getAdminOverview(ctx.db, now);

    expect(overview.manualOrdersNeedingWork).toBe(2);
  });

  it("counts open and manual-review tickets as new work", async () => {
    const seedRow = await seed();
    const testCustomerId = newId();
    const testTelegramUserId = "990001";
    await sql`insert into customer (id, status, locale) values (${testCustomerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id)
      values (${newId()}, ${testCustomerId}, 'TELEGRAM', ${testTelegramUserId})
    `.execute(ctx.db);
    await sql`
      insert into test_customer_allowlist (id, telegram_user_id, note, added_by)
      values (${newId()}, ${testTelegramUserId}, 'overview test', 'test')
    `.execute(ctx.db);
    await sql`
      insert into support_ticket (id, customer_id, reason_code, status, safe_summary, due_at)
      values (${newId()}, ${testCustomerId}, 'OTHER', 'OPEN', 'test customer', now())
    `.execute(ctx.db);
    for (const status of ["OPEN", "MANUAL_REVIEW", "RESOLVED"]) {
      const id = newId();
      await sql`
        insert into support_ticket (id, customer_id, reason_code, status, safe_summary, due_at)
        values (${id}, ${seedRow.customerId}, 'OTHER', ${status}, 'seed', now())
      `.execute(ctx.db);
    }
    const overview = await getAdminOverview(ctx.db, new Date("2026-09-10T04:00:00.000Z"));
    expect(overview.newTickets).toBe(2);
  });

  it("is empty, not throwing, on a store with no trade at all", async () => {
    await seed();
    const overview = await getAdminOverview(ctx.db, new Date("2026-09-10T04:00:00.000Z"));
    expect(overview.revenueTodayVnd).toBe(0n);
    expect(overview.ordersToday).toBe(0);
    expect(overview.awaitingAction).toBe(0);
    expect(overview.paymentsNeedingReview).toBe(0);
    expect(overview.newTickets).toBe(0);
  });
});
