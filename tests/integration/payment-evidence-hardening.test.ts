import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../../src/infrastructure/db/client.js";
import { cancelUnpaidOrder, expireOverdueOrders } from "../../src/modules/commerce/buy-now.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import {
  applyPaymentEvidence,
  type ApplyEvidenceResult,
} from "../../src/modules/payments/service.js";
import type { VerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import { newId } from "../../src/shared/ids/index.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T124/T124a/T128 — payment evidence hardening and money-safety races.
 *
 * These tests deliberately cross the compile-time boundary with a cast when
 * proving runtime rejection: a caller that forges `PaymentEvidence` must never
 * be able to write a VERIFIED bank transaction.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("payment evidence hardening (T124/T124a/T128)", () => {
  let ctx: PgTestContext;
  let second: DbHandle;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
    second = createDb({ connectionString: ctx.connectionString });
  }, 180_000);

  afterAll(async () => {
    await second?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, "order", product_variant, product, category, customer cascade`.execute(
      ctx.db,
    );
  });

  interface Fixture {
    customerId: string;
    orderId: string;
    intentId: string;
    content: string;
    amount: number;
    account: string;
  }

  async function seedPayableOrder(
    options: { orderExpiresAt?: Date; intentExpiresAt?: Date } = {},
  ): Promise<Fixture> {
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const orderId = newId();
    const intentId = newId();
    const content = "ORD" + newId().slice(-12);
    const amount = 150000;
    const account = "0123456789";
    const orderExpiresAt = options.orderExpiresAt ?? new Date(Date.now() + 15 * 60_000);
    const intentExpiresAt = options.intentExpiresAt ?? orderExpiresAt;

    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${"c-" + categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${"p-" + productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${amount}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
    `.execute(ctx.db);
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status, expires_at)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
        ${amount}, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT', ${orderExpiresAt.toISOString()})
    `.execute(ctx.db);
    await sql`
      insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at)
      values (${intentId}, ${orderId}, 'PRESENTED', ${amount}, ${account}, ${content}, ${intentExpiresAt.toISOString()})
    `.execute(ctx.db);

    return { customerId, orderId, intentId, content, amount, account };
  }

  function evidenceFor(
    f: Fixture,
    overrides: Partial<PaymentEvidence> = {},
  ): VerifiedSePayEvidence {
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
      correlationId: "corr-" + newId().slice(-6),
      ...overrides,
    });
  }

  async function countRows(table: "bank_transaction" | "discrepancy" | "outbox_event") {
    const result =
      table === "bank_transaction"
        ? await sql<{
            count: string;
          }>`select count(*)::text as count from bank_transaction`.execute(ctx.db)
        : table === "discrepancy"
          ? await sql<{ count: string }>`select count(*)::text as count from discrepancy`.execute(
              ctx.db,
            )
          : await sql<{ count: string }>`select count(*)::text as count from outbox_event`.execute(
              ctx.db,
            );
    return Number(result.rows[0]?.count ?? 0);
  }

  it("rejects forgeable raw evidence before any VERIFIED row is written", async () => {
    const f = await seedPayableOrder();
    const raw: PaymentEvidence = {
      ...evidenceFor(f),
      providerTransactionId: "FORGED-1",
    };

    const result = await applyPaymentEvidence(ctx.db, raw as unknown as VerifiedSePayEvidence);

    expect(result).toEqual({ ok: false, error: "unverified payment evidence" });
    expect(await countRows("bank_transaction")).toBe(0);
  });

  it.each([
    ["raw hash", { rawHash: "mutated-hash" }],
    ["amount", { amountVnd: 150001 }],
    ["account", { merchantAccountId: "9999999999" }],
    ["content", { content: "OTHER-CONTENT" }],
    ["direction", { direction: "OUT" as const }],
  ])(
    "routes a duplicate provider ID mutated by %s to durable discrepancy",
    async (_label, mutation) => {
      const f = await seedPayableOrder();
      const providerTransactionId = "SEPAY-COLLISION-" + newId();
      const original = evidenceFor(f, { providerTransactionId });
      expect((await applyPaymentEvidence(ctx.db, original)).ok).toBe(true);

      const mutated = verifiedSePayEvidence({ ...original, ...mutation });
      const result = await applyPaymentEvidence(ctx.db, mutated);
      expect(result).toMatchObject({ ok: true, kind: "DISCREPANCY", type: "REFERENCE_COLLISION" });
      expect(await countRows("discrepancy")).toBe(1);
    },
  );

  it("rejects invalid and future transaction times before persistence", async () => {
    const f = await seedPayableOrder();
    const future = evidenceFor(f, { transactedAt: new Date(Date.now() + 61_000) });
    const futureResult = await applyPaymentEvidence(ctx.db, future);
    expect(futureResult).toEqual({ ok: false, error: "invalid transaction time" });

    const invalid = evidenceFor(f);
    Object.assign(invalid, { transactedAt: new Date("invalid") });
    const invalidResult = await applyPaymentEvidence(ctx.db, invalid);
    expect(invalidResult).toEqual({ ok: false, error: "invalid transaction time" });
    expect(await countRows("bank_transaction")).toBe(0);
  });

  it("projects a live-intent discrepancy to PAYMENT_NEEDS_REVIEW without OrderPaid", async () => {
    const f = await seedPayableOrder();
    const result = await applyPaymentEvidence(ctx.db, evidenceFor(f, { amountVnd: f.amount - 1 }));
    expect(result).toMatchObject({ ok: true, kind: "DISCREPANCY", type: "UNDERPAYMENT" });
    const order = await sql<{
      status: string;
    }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAYMENT_NEEDS_REVIEW");
    const paidEvents = await sql<{ count: string }>`
      select count(*)::text as count from outbox_event
      where aggregate_id = ${f.orderId} and event_type = 'OrderPaid'
    `.execute(ctx.db);
    expect(Number(paidEvents.rows[0]?.count ?? 0)).toBe(0);
  });

  it("returns typed ALREADY_PAID when cancellation loses to verified settlement", async () => {
    const f = await seedPayableOrder();
    const settled = await applyPaymentEvidence(ctx.db, evidenceFor(f));
    expect(settled).toMatchObject({ ok: true, kind: "SETTLED" });

    const cancelled = await cancelUnpaidOrder(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      correlationId: "cancel-after-payment",
    });
    expect(cancelled).toEqual({
      ok: false,
      code: "ALREADY_PAID",
      message: "Đơn hàng đã được thanh toán.",
    });
  });

  it("converges concurrent cancellation and settlement without a thrown race", async () => {
    const outcomes: Array<{
      cancel: BuyNowOutcome;
      payment: ApplyEvidenceResult;
      status: string;
      orderPaid: number;
    }> = [];
    for (let i = 0; i < 5; i += 1) {
      const f = await seedPayableOrder();
      const paymentEvidence = evidenceFor(f);
      const [cancel, payment] = await Promise.all([
        cancelUnpaidOrder(second.db, {
          orderId: f.orderId,
          customerId: f.customerId,
          correlationId: `cancel-race-${i}`,
        }),
        applyPaymentEvidence(ctx.db, paymentEvidence),
      ]);
      const order = await sql<{
        status: string;
      }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
      const paidEvents = await sql<{ count: string }>`
        select count(*)::text as count from outbox_event
        where aggregate_id = ${f.orderId} and event_type = 'OrderPaid'
      `.execute(ctx.db);
      outcomes.push({
        cancel: cancel as BuyNowOutcome,
        payment,
        status: order.rows[0]?.status ?? "MISSING",
        orderPaid: Number(paidEvents.rows[0]?.count ?? 0),
      });
    }

    for (const outcome of outcomes) {
      expect(outcome.cancel.ok ? "CANCELLED" : outcome.cancel.code).toMatch(
        /CANCELLED|ALREADY_PAID|ORDER_NOT_CANCELLABLE/,
      );
      expect(outcome.payment.ok ? outcome.payment.kind : outcome.payment.error).toMatch(
        /SETTLED|DISCREPANCY|invalid transaction time/,
      );
      if (outcome.cancel.ok) {
        expect(outcome.status).toBe("CANCELLED");
        expect(outcome.payment).toMatchObject({ ok: true, kind: "DISCREPANCY" });
        expect(outcome.orderPaid).toBe(0);
      } else if (outcome.cancel.code === "ALREADY_PAID") {
        expect(outcome.status).toBe("PAID");
        expect(outcome.payment).toMatchObject({ ok: true, kind: "SETTLED" });
        expect(outcome.orderPaid).toBe(1);
      }
    }
  });

  it("expiry worker re-reads under lock and never expires a concurrently settled order", async () => {
    const now = new Date();
    const f = await seedPayableOrder({
      orderExpiresAt: new Date(now.getTime() - 1_000),
      intentExpiresAt: new Date(now.getTime() - 1_000),
    });
    const payment = evidenceFor(f, { transactedAt: new Date(now.getTime() - 2_000) });
    const [expired, settled] = await Promise.all([
      expireOverdueOrders(second.db, { now }),
      applyPaymentEvidence(ctx.db, payment, now),
    ]);
    expect(expired).toBeGreaterThanOrEqual(0);
    expect(settled.ok).toBe(true);
    const row = await sql<{
      status: string;
    }>`select status from "order" where id = ${f.orderId}`.execute(ctx.db);
    expect(["PAID", "EXPIRED", "PAYMENT_NEEDS_REVIEW"]).toContain(row.rows[0]?.status);
    if (row.rows[0]?.status === "PAID") {
      expect(expired).toBe(0);
      expect(settled).toMatchObject({ ok: true, kind: "SETTLED" });
    } else {
      expect(settled).toMatchObject({ ok: true, kind: "DISCREPANCY" });
    }
  });
});

type BuyNowOutcome =
  { ok: true; order: { status: string } } | { ok: false; code: string; message: string };
