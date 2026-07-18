import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T043 — Payment discrepancy classification (FR-011, SC-008).
 *
 * A verified inbound transfer that does not exactly match a live intent must
 * NOT settle. Instead it records a typed discrepancy and (for a live intent)
 * flags the intent NEEDS_REVIEW + emits PaymentNeedsReview AND freezes the
 * Order at PAYMENT_NEEDS_REVIEW so a refresh cannot mint a second QR (T124).
 * Late-payment is judged by evidence.transactedAt, not processing wall-clock.
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

async function seedPayableOrder(opts?: { expiresInMinutes?: number }): Promise<Fixture> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const intentId = newId();
  const content = "ORD" + newId().slice(-12);
  const amount = 150000;
  const account = "0123456789";
  const mins = opts?.expiresInMinutes ?? 15;

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', 'c', true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', 'p', true, 1)`.execute(
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
    values (${intentId}, ${orderId}, 'PRESENTED', ${amount}, ${account}, ${content},
      now() + (${mins} || ' minutes')::interval)
  `.execute(ctx.db);

  return { orderId, intentId, content, amount, account };
}

function evidenceFor(f: Fixture, over: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    provider: "sepay",
    providerTransactionId: "SEPAY-" + newId(),
    direction: "IN",
    merchantAccountId: f.account,
    amountVnd: f.amount,
    content: f.content,
    reference: "FT-" + newId().slice(-6),
    transactedAt: new Date(),
    rawHash: "hash-" + newId(),
    correlationId: "corr-" + newId().slice(-6),
    ...over,
  };
}

async function countDiscrepancy(type: string): Promise<number> {
  const r = await sql<{ count: string }>`
    select count(*)::text as count from discrepancy where type = ${type}
  `.execute(ctx.db);
  return Number(r.rows[0]?.count);
}

async function orderStatus(orderId: string): Promise<string | undefined> {
  const r = await sql<{ status: string }>`select status from "order" where id = ${orderId}`.execute(
    ctx.db,
  );
  return r.rows[0]?.status;
}

async function settledAllocations(): Promise<number> {
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

describe("payment discrepancy classification (FR-011)", () => {
  it("underpayment does not settle and records UNDERPAYMENT", async () => {
    const f = await seedPayableOrder();
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { amountVnd: f.amount - 1 })),
    );
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "UNDERPAYMENT" });
    expect(await countDiscrepancy("UNDERPAYMENT")).toBe(1);
    expect(await settledAllocations()).toBe(0);
    // A discrepancy against a LIVE intent freezes the order under review (T124)
    // so a refresh cannot mint a second QR against the same unpaid order.
    expect(await orderStatus(f.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
  });

  it("overpayment does not settle and records OVERPAYMENT", async () => {
    const f = await seedPayableOrder();
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { amountVnd: f.amount + 5000 })),
    );
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "OVERPAYMENT" });
    expect(await countDiscrepancy("OVERPAYMENT")).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
  });

  it("wrong account records WRONG_ACCOUNT", async () => {
    const f = await seedPayableOrder();
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { merchantAccountId: "9999999999" })),
    );
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "WRONG_ACCOUNT" });
    expect(await countDiscrepancy("WRONG_ACCOUNT")).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
  });

  it("unrecognized transfer content records UNMATCHED (no intent)", async () => {
    const f = await seedPayableOrder();
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { content: "ORDNOSUCHCONTENT" })),
    );
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "UNMATCHED" });
    expect(await countDiscrepancy("UNMATCHED")).toBe(1);
    // Order untouched — content pointed at nothing.
    expect(await orderStatus(f.orderId)).toBe("PENDING_PAYMENT");
  });

  it("never falls back to free-form content when a structured provider code is present", async () => {
    const f = await seedPayableOrder();
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(
        evidenceFor(f, { structuredCode: "ORD-WRONG-CODE", content: f.content }),
      ),
    );
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "UNMATCHED" });
    expect(await settledAllocations()).toBe(0);
    expect(await orderStatus(f.orderId)).toBe("PENDING_PAYMENT");
  });

  it("payment whose TRANSFER happened after expiry records LATE_PAYMENT (T124)", async () => {
    const f = await seedPayableOrder({ expiresInMinutes: 15 });
    // Lateness is judged by the bank transfer time, not our processing clock.
    // Transfer stamped 30 minutes out → past the 15-minute window + skew.
    const transactedLate = new Date(Date.now() + 30 * 60_000);
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { transactedAt: transactedLate })),
      new Date(Date.now() + 31 * 60_000),
    );
    expect(res).toMatchObject({ kind: "DISCREPANCY", type: "LATE_PAYMENT" });
    expect(await countDiscrepancy("LATE_PAYMENT")).toBe(1);
    expect(await settledAllocations()).toBe(0);
    // Order is frozen under review so a refresh cannot mint a second QR.
    expect(await orderStatus(f.orderId)).toBe("PAYMENT_NEEDS_REVIEW");
  });

  it("a settlement webhook that ARRIVES late but whose transfer was on time still settles (T124)", async () => {
    const f = await seedPayableOrder({ expiresInMinutes: 15 });
    // Transfer stamped 1 minute before expiry, processed 30 minutes later.
    const transactedOnTime = new Date(Date.now() + 14 * 60_000);
    const processedLate = new Date(Date.now() + 45 * 60_000);
    const res = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { transactedAt: transactedOnTime })),
      processedLate,
    );
    expect(res).toMatchObject({ kind: "SETTLED" });
    expect(await settledAllocations()).toBe(1);
    expect(await orderStatus(f.orderId)).toBe("PAID");
  });

  it("a live intent hit by a discrepancy is flagged NEEDS_REVIEW with a PaymentNeedsReview event", async () => {
    const f = await seedPayableOrder();
    await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence(evidenceFor(f, { amountVnd: f.amount + 1 })),
    );
    const intent = await sql<{ status: string }>`
      select status from payment_intent where id = ${f.intentId}
    `.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("NEEDS_REVIEW");
    const events = await sql<{ count: string }>`
      select count(*)::text as count from outbox_event where event_type = 'PaymentNeedsReview'
    `.execute(ctx.db);
    expect(Number(events.rows[0]?.count)).toBe(1);
  });

  it("replaying the same discrepancy evidence is idempotent (one discrepancy)", async () => {
    const f = await seedPayableOrder();
    const ev = evidenceFor(f, { amountVnd: f.amount - 10 });
    await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(ev));
    const second = await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(ev));
    // Second application dedupes on the provider txn id.
    expect(second).toMatchObject({ kind: "ALREADY_APPLIED" });
    expect(await countDiscrepancy("UNDERPAYMENT")).toBe(1);
  });
});
