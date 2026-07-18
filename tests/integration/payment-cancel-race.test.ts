import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { cancelUnpaidOrder } from "../../src/modules/commerce/buy-now.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T123 — Cancel-versus-settlement race (money-safety).
 *
 * A cancelled Order must NEVER emit `OrderPaid`, even if money arrives after
 * cancel against the previously-presented QR. The independent review found that
 * cancel left the Payment Intent live, so a later SePay transfer settled it and
 * enqueued OrderPaid while the Order remained CANCELLED.
 *
 * Required convergence:
 *   - cancel voids the live intent atomically with the Order → CANCELLED;
 *   - money arriving after cancel is a discrepancy (not settlement);
 *   - no OrderPaid outbox event is written.
 *
 * Requires Docker/Testcontainers. Skipped with an explicit reason when absent.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("cancel-versus-settlement race (T123)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
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

  async function seedPayableOrderWithIntent(): Promise<Fixture> {
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
        now() + interval '15 minutes')
    `.execute(ctx.db);

    return { customerId, orderId, intentId, content, amount, account };
  }

  function evidenceFor(f: Fixture): PaymentEvidence {
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
    };
  }

  it("cancel voids the live intent so a later transfer cannot settle", async () => {
    const f = await seedPayableOrderWithIntent();

    const cancelled = await cancelUnpaidOrder(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      correlationId: "cancel-1",
    });
    expect(cancelled.ok).toBe(true);

    const intent = await sql<{ status: string }>`
      select status from payment_intent where id = ${f.intentId}
    `.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("FAILED");

    const order = await sql<{ status: string }>`
      select status from "order" where id = ${f.orderId}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("CANCELLED");
  });

  it("money arriving after cancel is a discrepancy, never OrderPaid", async () => {
    const f = await seedPayableOrderWithIntent();
    await cancelUnpaidOrder(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      correlationId: "cancel-2",
    });

    const res = await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(evidenceFor(f)));
    // Must NOT settle — money for a cancelled order is a discrepancy.
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.kind).toBe("DISCREPANCY");
    }

    const settled = await sql<{ count: string }>`
      select count(*)::text as count from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(Number(settled.rows[0]?.count)).toBe(0);

    const orderPaid = await sql<{ count: string }>`
      select count(*)::text as count from outbox_event where event_type = 'OrderPaid'
    `.execute(ctx.db);
    expect(Number(orderPaid.rows[0]?.count)).toBe(0);

    // Order remains CANCELLED (never flipped to PAID).
    const order = await sql<{ status: string }>`
      select status from "order" where id = ${f.orderId}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("CANCELLED");

    // Discrepancy recorded so ops can refund the stranded money.
    const disc = await sql<{ count: string }>`
      select count(*)::text as count from discrepancy where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(disc.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });
});
