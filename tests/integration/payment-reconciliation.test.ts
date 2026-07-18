import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { VerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import {
  reconcileSePay,
  type SePayReconciliationPort,
} from "../../src/modules/payments/reconciliation.js";
import { createInMemoryRateLimiter } from "../../src/modules/risk/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T044 — Missing-webhook reconciliation + provider rate/backoff (FR-012).
 *
 * Reconciliation queries a bounded provider window and feeds any transaction we
 * have not recorded through the SAME verification/match rules as the webhook
 * (it cannot bypass them). A missing webhook is recovered into a settlement; a
 * duplicate is a no-op; a mismatched provider row becomes a discrepancy, never a
 * silent mark-paid. Provider calls respect a rate-limit budget with backoff.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  intentId: string;
  content: string;
  amount: number;
  account: string;
}

async function seedPayableOrder(): Promise<Fixture> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const intentId = newId();
  const content = "ORD" + newId().slice(-12);
  const amount = 150000;
  const account = "0123456789";

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  // Unique slug per seed so multi-order cases (rate-limit) do not collide.
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${amount}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      ${amount}, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at)
    values (${intentId}, ${orderId}, 'PRESENTED', ${amount}, ${account}, ${content}, now() + interval '15 minutes')
  `.execute(ctx.db);

  return { orderId, intentId, content, amount, account };
}

function providerTxn(f: Fixture, over: Partial<PaymentEvidence> = {}): VerifiedSePayEvidence {
  return verifiedSePayEvidence({
    provider: "sepay",
    providerTransactionId: "SEPAY-" + newId(),
    direction: "IN",
    merchantAccountId: f.account,
    amountVnd: f.amount,
    content: f.content,
    reference: "FT-" + newId().slice(-6),
    transactedAt: new Date(),
    rawHash: "hash-" + newId(),
    correlationId: "recon-" + newId().slice(-6),
    ...over,
  });
}

/** A port whose backing list is fixed for the test. */
function portOf(txns: VerifiedSePayEvidence[]): SePayReconciliationPort {
  return {
    listTransactions() {
      return Promise.resolve(txns);
    },
  };
}

async function orderStatus(orderId: string): Promise<string | undefined> {
  const r = await sql<{ status: string }>`select status from "order" where id = ${orderId}`.execute(
    ctx.db,
  );
  return r.rows[0]?.status;
}

async function settledCount(): Promise<number> {
  const r = await sql<{ count: string }>`
    select count(*)::text as count from payment_allocation where status = 'SETTLED'
  `.execute(ctx.db);
  return Number(r.rows[0]?.count);
}

beforeEach(async () => {
  await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("SePay reconciliation (FR-012)", () => {
  it("recovers a missing webhook into a settlement", async () => {
    const f = await seedPayableOrder();
    const txn = providerTxn(f);
    const summary = await reconcileSePay(ctx.db, {
      port: portOf([txn]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
    });

    expect(summary.scanned).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(summary.alreadyPresent).toBe(0);
    expect(await orderStatus(f.orderId)).toBe("PAID");
    expect(await settledCount()).toBe(1);
  });

  it("is a no-op when the webhook already settled the transaction", async () => {
    const f = await seedPayableOrder();
    const txn = providerTxn(f);
    // Webhook path settled it first.
    await applyPaymentEvidence(ctx.db, txn);
    expect(await settledCount()).toBe(1);

    // Reconciliation sees the same provider txn id → already present, no double effect.
    const summary = await reconcileSePay(ctx.db, {
      port: portOf([txn]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
    });
    expect(summary.alreadyPresent).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(await settledCount()).toBe(1);
  });

  it("cannot bypass verification — a mismatched provider row becomes a discrepancy", async () => {
    const f = await seedPayableOrder();
    const txn = providerTxn(f, { amountVnd: f.amount - 1 });
    const summary = await reconcileSePay(ctx.db, {
      port: portOf([txn]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
    });
    expect(summary.recovered).toBe(0);
    expect(summary.discrepancies).toBe(1);
    // T124/T128: a live-intent discrepancy freezes the Order under review so a
    // refresh cannot mint a second QR (was incorrectly left PENDING_PAYMENT).
    expect(await orderStatus(f.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
    expect(await settledCount()).toBe(0);
  });

  it("respects the provider rate-limit budget and reports throttling", async () => {
    const f1 = await seedPayableOrder();
    const f2 = await seedPayableOrder();
    const f3 = await seedPayableOrder();
    // Budget of 2 provider calls; the 3rd is throttled and deferred.
    const limiter = createInMemoryRateLimiter({ capacity: 2, refillPerSecond: 0 });
    const summary = await reconcileSePay(ctx.db, {
      port: portOf([providerTxn(f1), providerTxn(f2), providerTxn(f3)]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
      rateLimiter: limiter,
      rateLimitKey: "sepay-recon",
    });
    expect(summary.scanned).toBe(2);
    expect(summary.throttled).toBe(1);
    expect(summary.recovered).toBe(2);
    // The throttled order stays unpaid until the next window.
    expect(await orderStatus(f3.orderId)).toBe("PENDING_PAYMENT");
  });

  it("replaying reconciliation is idempotent (no duplicate settlement)", async () => {
    const f = await seedPayableOrder();
    const txn = providerTxn(f);
    const opts = {
      port: portOf([txn]),
      windowFromSec: 0,
      windowToSec: Math.floor(Date.now() / 1000),
    };
    await reconcileSePay(ctx.db, opts);
    const second = await reconcileSePay(ctx.db, opts);
    expect(second.recovered).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(await settledCount()).toBe(1);
  });
});
