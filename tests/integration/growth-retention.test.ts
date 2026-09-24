import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { claimPaymentReminder } from "../../src/modules/payments/reminder.js";
import { recordFunnelEvent } from "../../src/modules/operations/funnel.js";
import { newId } from "../../src/shared/ids/index.js";
import { reservePromotion } from "../../src/modules/promotions/service.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  createReview,
  getReviewEligibility,
  listVisibleProductReviews,
  moderateReview,
} from "../../src/modules/reviews/service.js";

import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

describe("growth funnel durability", () => {
  it("counts a retried business event once by canonical event key", async () => {
    const eventKey = `integration-checkout:${Date.now()}`;

    await recordFunnelEvent(ctx.db, {
      eventKey,
      eventName: "CHECKOUT_STARTED",
    });
    await recordFunnelEvent(ctx.db, {
      eventKey,
      eventName: "CHECKOUT_STARTED",
    });

    const receipt = await sql<{ count: number }>`
      select count(*)::int as count
      from funnel_event_receipt
      where event_key = ${eventKey}
    `.execute(ctx.db);
    const aggregate = await sql<{ event_count: number }>`
      select event_count
      from funnel_event_daily
      where event_name = 'CHECKOUT_STARTED' and variant_key = '' and event_date = current_date
    `.execute(ctx.db);

    expect(receipt.rows[0]?.count).toBe(1);
    expect(aggregate.rows[0]?.event_count).toBe(1);
  });

  it("stops payment reminders after the configured maximum", async () => {
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const orderId = newId();

    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Growth', ${`growth-${categoryId.slice(-8)}`}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order)
      values (${productId}, ${categoryId}, 'Growth product', ${`product-${productId.slice(-8)}`}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
         stock_policy, resale_evidence_id, fulfillment_type)
      values
        (${variantId}, ${productId}, ${`SKU-${variantId.slice(-8)}`}, 'Growth variant', 100000,
         'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-GROWTH', 'STOCK_ACCOUNT')
    `.execute(ctx.db);
    await sql`
      insert into "order"
        (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
         price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type,
         status, expires_at)
      values
        (${orderId}, ${`ORD-${orderId.slice(-8)}`}, ${customerId}, ${variantId}, 'Growth product',
         'Growth variant', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT',
         'PENDING_PAYMENT', now() + interval '15 minutes')
    `.execute(ctx.db);

    expect(
      await claimPaymentReminder(ctx.db, {
        orderId,
        customerId,
        cooldownSeconds: 60,
        maxReminders: 2,
      }),
    ).toBe(true);
    expect(
      await claimPaymentReminder(ctx.db, {
        orderId,
        customerId,
        cooldownSeconds: 60,
        maxReminders: 2,
      }),
    ).toBe(false);

    await sql`
      update payment_reminder
      set last_sent_at = now() - interval '61 seconds'
      where order_id = ${orderId}
    `.execute(ctx.db);
    expect(
      await claimPaymentReminder(ctx.db, {
        orderId,
        customerId,
        cooldownSeconds: 60,
        maxReminders: 2,
      }),
    ).toBe(true);

    await sql`
      update payment_reminder
      set last_sent_at = now() - interval '61 seconds'
      where order_id = ${orderId}
    `.execute(ctx.db);
    expect(
      await claimPaymentReminder(ctx.db, {
        orderId,
        customerId,
        cooldownSeconds: 60,
        maxReminders: 2,
      }),
    ).toBe(false);
  });

  it("serializes a one-use promotion cap across concurrent reservations", async () => {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const promotionId = newId();
    const customerIds = [newId(), newId()];
    const orderIds = [newId(), newId()];

    await Promise.all(
      customerIds.map((customerId) =>
        sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
          ctx.db,
        ),
      ),
    );
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Promotion', ${`promo-${categoryId.slice(-8)}`}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order)
      values (${productId}, ${categoryId}, 'Promotion product', ${`promo-product-${productId.slice(-8)}`}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
         stock_policy, resale_evidence_id, fulfillment_type)
      values
        (${variantId}, ${productId}, ${`PROMO-${variantId.slice(-8)}`}, 'Promotion variant', 100000,
         'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-PROMO', 'STOCK_ACCOUNT')
    `.execute(ctx.db);
    await sql`
      insert into promotion
        (id, code_normalized, kind, value_percent, max_total_uses, minimum_order_value_vnd)
      values (${promotionId}, 'RACE20', 'PERCENT', 20, 1, 0)
    `.execute(ctx.db);
    await Promise.all(
      orderIds.map((orderId, index) =>
        sql`
          insert into "order"
            (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
             price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type,
             status, expires_at)
          values
            (${orderId}, ${`ORD-PROMO-${orderId.slice(-8)}`}, ${customerIds[index]}, ${variantId},
             'Promotion product', 'Promotion variant', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY',
             'STOCK_ACCOUNT', 'PENDING_PAYMENT', now() + interval '15 minutes')
        `.execute(ctx.db),
      ),
    );

    const results = await Promise.all(
      orderIds.map((orderId, index) =>
        withTransaction(ctx.db, (trx) =>
          reservePromotion(trx, {
            code: "RACE20",
            customerId: customerIds[index]!,
            orderId,
            baseAmountVnd: 100000n,
            productId,
            variantId,
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "TOTAL_LIMIT")).toHaveLength(1);
    const count = await sql<{ count: number }>`
      select count(*)::int as count
      from promotion_redemption
      where promotion_id = ${promotionId}
    `.execute(ctx.db);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("requires real delivered payment evidence and keeps review identity private", async () => {
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const orderId = newId();
    const intentId = newId();
    const bankTransactionId = newId();
    const assetId = newId();

    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Reviews', ${`review-${categoryId.slice(-8)}`}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product
        (id, category_id, name_vi, slug, is_active, is_test, is_archived, sort_order)
      values
        (${productId}, ${categoryId}, 'Review product', ${`review-product-${productId.slice(-8)}`},
         true, false, false, 1)
    `.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
         stock_policy, resale_evidence_id, fulfillment_type)
      values
        (${variantId}, ${productId}, ${`REVIEW-${variantId.slice(-8)}`}, 'Review variant', 100000,
         'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-REVIEW', 'STOCK_ACCOUNT')
    `.execute(ctx.db);
    await sql`
      insert into "order"
        (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
         price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type,
         status, completed_at)
      values
        (${orderId}, ${`ORD-REVIEW-${orderId.slice(-8)}`}, ${customerId}, ${variantId},
         'Review product', 'Review variant', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY',
         'STOCK_ACCOUNT', 'COMPLETED', now())
    `.execute(ctx.db);
    await sql`
      insert into payment_intent
        (id, order_id, status, amount_vnd, merchant_account_id, transfer_content,
         expires_at, settled_at)
      values
        (${intentId}, ${orderId}, 'SUCCEEDED', 100000, 'merchant-review', ${`PAY-${intentId}`},
         now() + interval '15 minutes', now())
    `.execute(ctx.db);
    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
         transacted_at, raw_hash, signature_status, schema_version)
      values
        (${bankTransactionId}, 'test', ${`txn-${bankTransactionId}`}, 'IN', 'merchant-review',
         100000, now(), ${`hash-${bankTransactionId}`}, 'VERIFIED', '1')
    `.execute(ctx.db);
    await sql`
      insert into payment_allocation
        (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status,
         decision_code, correlation_id)
      values
        (${newId()}, ${bankTransactionId}, ${intentId}, 100000, 'SETTLED', 'EXACT_MATCH', 'review-test')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status, delivered_order_id)
      values
        (${assetId}, ${variantId}, 'LOCAL', ${`vault:${assetId}`}, ${`fingerprint-${assetId}`},
         'DELIVERED', ${orderId})
    `.execute(ctx.db);

    expect(await getReviewEligibility(ctx.db, { orderId, customerId })).toMatchObject({
      orderId,
      customerId,
      productId,
      variantId,
    });
    const created = await createReview(ctx.db, {
      orderId,
      customerId,
      rating: 5,
      comment: "Giao nhanh",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const visible = await listVisibleProductReviews(ctx.db, {
      productId,
      aliasSalt: "review-alias-key-material-12345678901234567890",
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.customerAlias).not.toContain(customerId);
    expect(visible[0]?.comment).toBe("Giao nhanh");

    await sql`update product set is_test = true where id = ${productId}`.execute(ctx.db);
    expect(await getReviewEligibility(ctx.db, { orderId, customerId })).toBeNull();
    await sql`update product set is_test = false where id = ${productId}`.execute(ctx.db);
    await sql`update payment_intent set status = 'REFUNDED' where id = ${intentId}`.execute(ctx.db);
    expect(await getReviewEligibility(ctx.db, { orderId, customerId })).toBeNull();

    const moderated = await moderateReview(ctx.db, {
      reviewId: created.reviewId,
      status: "HIDDEN",
      adminId: "admin-review-test",
      reason: "policy check",
      correlationId: "review-moderation-test",
    });
    expect(moderated).toEqual({ ok: true });
    const audit = await sql<{ count: number }>`
      select count(*)::int as count
      from audit_event
      where action = 'review.hide' and target_id = ${created.reviewId}
    `.execute(ctx.db);
    expect(audit.rows[0]?.count).toBe(1);
  });
});
