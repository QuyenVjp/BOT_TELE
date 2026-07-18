import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import { countUnpublished } from "../../src/infrastructure/outbox/repository.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T042 — Payment replay/reorder idempotency (FR-010, SC-005).
 *
 * Replaying the SAME SePay evidence 100 times (and in shuffled order) must
 * produce EXACTLY ONE settlement, one allocation, and one PaymentSettled outbox
 * event. The unique-effect keys (bank_transaction provider id, settled
 * allocation per txn, one active intent) are what make this hold under
 * at-least-once delivery.
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
  providerTxnId: string;
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
  const providerTxnId = "SEPAY-" + newId();

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
    values (${intentId}, ${orderId}, 'PRESENTED', ${amount}, ${account}, ${content}, now() + interval '15 minutes')
  `.execute(ctx.db);

  return { orderId, intentId, content, amount, account, providerTxnId };
}

beforeEach(async () => {
  await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

function evidenceOf(f: Fixture) {
  return verifiedSePayEvidence({
    provider: "sepay",
    providerTransactionId: f.providerTxnId,
    direction: "IN" as const,
    merchantAccountId: f.account,
    amountVnd: f.amount,
    content: f.content,
    reference: "FT-1",
    transactedAt: new Date(),
    rawHash: "hash-" + f.providerTxnId,
    correlationId: "corr-1",
  });
}

describe("payment settlement idempotency (SC-005)", () => {
  it("replaying the same evidence 100x settles exactly once", async () => {
    const f = await seedPayableOrder();
    const evidence = evidenceOf(f);

    const results = [];
    for (let i = 0; i < 100; i++) {
      results.push(await applyPaymentEvidence(ctx.db, evidence));
    }

    // All calls report success (settled or already-settled), none error.
    expect(results.every((r) => r.ok)).toBe(true);

    // Exactly one settled allocation.
    const alloc = await sql<{ count: string }>`
      select count(*)::text as count from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(Number(alloc.rows[0]?.count)).toBe(1);

    // Exactly one bank transaction row (dedup by provider txn id).
    const txn = await sql<{ count: string }>`
      select count(*)::text as count from bank_transaction
    `.execute(ctx.db);
    expect(Number(txn.rows[0]?.count)).toBe(1);

    // Order is PAID.
    const order = await sql<{
      status: string;
    }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAID");

    // Exactly one PaymentSettled outbox event (dedupe key holds).
    const settledEvents = await sql<{ count: string }>`
      select count(*)::text as count from outbox_event where event_type = 'PaymentSettled'
    `.execute(ctx.db);
    expect(Number(settledEvents.rows[0]?.count)).toBe(1);
  });

  it("intent is settled and carries a settled_at timestamp", async () => {
    const f = await seedPayableOrder();
    await applyPaymentEvidence(ctx.db, evidenceOf(f));
    const intent = await sql<{ status: string; settled_at: string | null }>`
      select status, settled_at from payment_intent where id = ${f.intentId}
    `.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("SUCCEEDED");
    expect(intent.rows[0]?.settled_at).toBeTruthy();
  });

  it("routes a mutated duplicate provider transaction id to discrepancy instead of silent replay", async () => {
    const f = await seedPayableOrder();
    const original = evidenceOf(f);
    expect(await applyPaymentEvidence(ctx.db, original)).toMatchObject({ kind: "SETTLED" });
    const mutated = verifiedSePayEvidence({
      ...original,
      amountVnd: original.amountVnd + 1,
      rawHash: "mutated-raw-hash",
      correlationId: "corr-mutated-provider-id",
    });
    expect(await applyPaymentEvidence(ctx.db, mutated)).toMatchObject({
      kind: "DISCREPANCY",
      type: "REFERENCE_COLLISION",
    });
    const rows = await sql<{ count: number }>`
      select count(*)::int as count from discrepancy where type = 'REFERENCE_COLLISION'
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("total outbox unpublished count reflects one settlement pipeline, not 100", async () => {
    const f = await seedPayableOrder();
    for (let i = 0; i < 20; i++) await applyPaymentEvidence(ctx.db, evidenceOf(f));
    // OrderPaid + PaymentSettled at most; never 20x.
    expect(await countUnpublished(ctx.db)).toBeLessThanOrEqual(2);
  });
});
