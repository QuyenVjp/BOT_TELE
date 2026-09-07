import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { VerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import {
  SEPAY_RECONCILIATION_CURSOR_CONFLICT,
  createPostgresSePayReconciliationCursorStore,
  reconcileSePay,
  type SePayReconciliationPort,
} from "../../src/modules/payments/reconciliation.js";
import { createInMemoryRateLimiter } from "../../src/modules/risk/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
import { performance } from "node:perf_hooks";

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
    providerTransactionId: "api:" + randomUUID(),
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
  await sql`truncate table sepay_reconciliation_cursor, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("SePay reconciliation (FR-012)", () => {
  it("measures distinct settlements and concurrent replay without duplicate allocations", async () => {
    const evidence: VerifiedSePayEvidence[] = [];
    for (let i = 0; i < 100; i++) evidence.push(providerTxn(await seedPayableOrder()));
    const started = performance.now();
    await Promise.all(evidence.map((row) => applyPaymentEvidence(ctx.db, row)));
    const distinctMs = performance.now() - started;
    const replayStarted = performance.now();
    await Promise.all([...evidence, ...evidence].map((row) => applyPaymentEvidence(ctx.db, row)));
    const replayMs = performance.now() - replayStarted;
    expect(await settledCount()).toBe(100);
    const count = await sql<{
      count: number;
    }>`select count(*)::int as count from bank_transaction`.execute(ctx.db);
    expect(count.rows[0]?.count).toBe(100);
    console.warn(
      JSON.stringify({
        probe: "sepay-distinct-replay",
        distinct: 100,
        replays: 200,
        distinctMs,
        replayMs,
        production: false,
      }),
    );
  });
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

  it("resumes from the persisted page after restart without skipped or duplicate allocations", async () => {
    const first = await seedPayableOrder();
    const second = await seedPayableOrder();
    const firstTxn = providerTxn(first);
    const secondTxn = providerTxn(second);
    const calls: number[] = [];
    const port: SePayReconciliationPort = {
      listTransactions(_from, _to, _limit, options) {
        const page = options?.page ?? 1;
        calls.push(page);
        return Promise.resolve(page === 1 ? [firstTxn] : [secondTxn]);
      },
    };

    const firstStore = createPostgresSePayReconciliationCursorStore(ctx.db);
    const claimed = await firstStore.claim("sepay", 100, 200, 1);
    const firstSummary = await reconcileSePay(ctx.db, {
      port,
      windowFromSec: claimed.windowFromSec,
      windowToSec: claimed.windowToSec,
      maxTransactions: claimed.perPage,
      page: claimed.page,
    });
    expect(firstSummary).toMatchObject({ scanned: 1, recovered: 1 });
    const advanced = await firstStore.advancePage(claimed);

    const cursor = await sql<{
      window_from_sec: number;
      window_to_sec: number;
      page: number;
      per_page: number;
    }>`
      select window_from_sec, window_to_sec, page, per_page
      from sepay_reconciliation_cursor
      where provider = 'sepay'
    `.execute(ctx.db);
    expect(cursor.rows[0]).toMatchObject({
      window_from_sec: advanced.windowFromSec,
      window_to_sec: advanced.windowToSec,
      page: advanced.page,
      per_page: advanced.perPage,
    });

    const secondSummary = await reconcileSePay(ctx.db, {
      port,
      windowFromSec: cursor.rows[0]!.window_from_sec,
      windowToSec: cursor.rows[0]!.window_to_sec,
      maxTransactions: cursor.rows[0]!.per_page,
      page: cursor.rows[0]!.page,
    });

    expect(calls).toEqual([1, 2]);
    expect(secondSummary).toMatchObject({ scanned: 1, recovered: 1, alreadyPresent: 0 });
    expect(await orderStatus(first.orderId)).toBe("PAID");
    expect(await orderStatus(second.orderId)).toBe("PAID");
    expect(await settledCount()).toBe(2);
    const allocations = await sql<{ provider_transaction_id: string; allocations: number }>`
      select bt.provider_transaction_id, count(pa.id)::int as allocations
      from bank_transaction bt
      join payment_allocation pa on pa.bank_transaction_id = bt.id and pa.status = 'SETTLED'
      where bt.provider_transaction_id in (${firstTxn.providerTransactionId}, ${secondTxn.providerTransactionId})
      group by bt.provider_transaction_id
      order by bt.provider_transaction_id
    `.execute(ctx.db);
    expect(allocations.rows).toEqual(
      [
        { provider_transaction_id: firstTxn.providerTransactionId, allocations: 1 },
        { provider_transaction_id: secondTxn.providerTransactionId, allocations: 1 },
      ].sort((a, b) => a.provider_transaction_id.localeCompare(b.provider_transaction_id)),
    );
  });

  it("rejects stale SePay cursor writers with generation CAS", async () => {
    const store = createPostgresSePayReconciliationCursorStore(ctx.db);
    const claimed = await store.claim("sepay", 100, 200, 20);
    const advanced = await store.advancePage(claimed);

    await expect(store.advancePage(claimed)).rejects.toThrow(SEPAY_RECONCILIATION_CURSOR_CONFLICT);
    await expect(store.completeWindow(claimed, 190, 300, 20)).rejects.toThrow(
      SEPAY_RECONCILIATION_CURSOR_CONFLICT,
    );
    expect(advanced.generation).toBe(claimed.generation + 1);
    expect(advanced.page).toBe(claimed.page + 1);
  });
});
