import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { recoverSePayBatch } from "../../src/modules/payments/recovery.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import type { SePayReconciliationPort } from "../../src/modules/payments/reconciliation.js";
import {
  formatSePayReconciliationAdminText,
  getSePayReconciliationStatus,
} from "../../src/modules/payments/reconciliation-status.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";
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
    truncate table sepay_reconciliation_cursor, webhook_inbox, wallet_ledger, wallet_account,
      outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent,
      order_transition, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedCommerce(): Promise<{ customerId: string; variantId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 150000, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-1', true, 1)
  `.execute(ctx.db);
  return { customerId, variantId };
}

async function seedOrder(seed: { customerId: string; variantId: string }): Promise<{
  orderId: string;
  intentId: string;
  content: string;
  account: string;
}> {
  const orderId = newId();
  const intentId = newId();
  const content = "ORD" + newId().slice(-12);
  const account = "0123456789";
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = new Date("2026-01-01T00:15:00.000Z");
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, expires_at, created_at, updated_at)
    values
      (${orderId}, ${"ORD-" + orderId}, ${seed.customerId}, ${seed.variantId}, 'P', 'V',
       150000, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT', ${expiresAt.toISOString()},
       ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, status, amount_vnd, merchant_account_id, transfer_content,
       expires_at, presented_at, created_at)
    values
      (${intentId}, ${orderId}, 'PRESENTED', 150000, ${account}, ${content},
       ${expiresAt.toISOString()}, ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `.execute(ctx.db);
  return { orderId, intentId, content, account };
}

describe("SePay missed-webhook reconciliation", () => {
  it("formats stale vs healthy admin copy without PII", () => {
    expect(
      formatSePayReconciliationAdminText({
        stale: false,
        lastSuccessAt: new Date(),
        minutesLate: 2,
        lastErrorClass: null,
        lastProviderCursor: null,
        consecutiveFailures: 0,
      }),
    ).toBe("✅ Đối soát bình thường");
    expect(
      formatSePayReconciliationAdminText({
        stale: true,
        lastSuccessAt: null,
        minutesLate: null,
        lastErrorClass: null,
        lastProviderCursor: null,
        consecutiveFailures: 0,
      }),
    ).toBe("⚠️ Đối soát SePay đã trễ (chưa có lần thành công).");
    expect(
      formatSePayReconciliationAdminText({
        stale: true,
        lastSuccessAt: new Date(Date.now() - 40 * 60_000),
        minutesLate: 40,
        lastErrorClass: "HTTP_ERROR",
        lastProviderCursor: null,
        consecutiveFailures: 2,
      }),
    ).toBe("⚠️ Đối soát SePay đã trễ 40 phút.");
  });

  it("backfills a missing ORD webhook once, then ALREADY_APPLIED on replay", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed);
    const inbox = await sql<{ n: number }>`select count(*)::int as n from webhook_inbox`.execute(
      ctx.db,
    );
    expect(inbox.rows[0]?.n ?? 0).toBe(0);

    const evidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + randomUUID(),
      direction: "IN",
      merchantAccountId: order.account,
      amountVnd: 150000,
      content: order.content,
      reference: "FT-missed-1",
      transactedAt: new Date("2026-01-01T00:01:00.000Z"),
      rawHash: "hash-missed-1",
      correlationId: "missed-webhook-1",
    } satisfies PaymentEvidence);
    const port: SePayReconciliationPort = {
      listTransactions() {
        return Promise.resolve([evidence]);
      },
    };

    const first = await recoverSePayBatch(ctx.db, {
      batchSize: 10,
      now: new Date("2026-01-01T00:10:00.000Z"),
      port,
    });
    expect(first.failed).toBe(0);
    const paid = await sql<{ status: string }>`
      select status from "order" where id = ${order.orderId}
    `.execute(ctx.db);
    expect(paid.rows[0]?.status).toBe("PAID");
    const allocations = await sql<{ n: number }>`
      select count(*)::int as n from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(allocations.rows[0]?.n).toBe(1);

    const replay = await applyPaymentEvidence(
      ctx.db,
      evidence,
      new Date("2026-01-01T00:11:00.000Z"),
    );
    expect(replay).toMatchObject({ ok: true, kind: "ALREADY_APPLIED" });

    const second = await recoverSePayBatch(ctx.db, {
      batchSize: 10,
      now: new Date("2026-01-01T00:12:00.000Z"),
      port,
    });
    expect(second.failed).toBe(0);
    const allocationsTwice = await sql<{ n: number }>`
      select count(*)::int as n from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(allocationsTwice.rows[0]?.n).toBe(1);
  });

  it("records unknown money as discrepancy without wallet or order settlement", async () => {
    const seed = await seedCommerce();
    const order = await seedOrder(seed);
    const evidence = verifiedSePayEvidence({
      provider: "sepay",
      providerTransactionId: "api:" + randomUUID(),
      direction: "IN",
      merchantAccountId: order.account,
      amountVnd: 150000,
      content: "UNMATCHED-MONEY-IN",
      reference: "FT-unknown-1",
      transactedAt: new Date("2026-01-01T00:01:00.000Z"),
      rawHash: "hash-unknown-1",
      correlationId: "unknown-money-1",
    } satisfies PaymentEvidence);
    const port: SePayReconciliationPort = {
      listTransactions() {
        return Promise.resolve([evidence]);
      },
    };

    await recoverSePayBatch(ctx.db, {
      batchSize: 10,
      now: new Date("2026-01-01T00:10:00.000Z"),
      port,
    });
    const paid = await sql<{ status: string }>`
      select status from "order" where id = ${order.orderId}
    `.execute(ctx.db);
    expect(paid.rows[0]?.status).toBe("PENDING_PAYMENT");
    const discrepancies = await sql<{
      n: number;
    }>`select count(*)::int as n from discrepancy`.execute(ctx.db);
    expect(discrepancies.rows[0]?.n).toBeGreaterThanOrEqual(1);
    const ledger = await sql<{ n: number }>`select count(*)::int as n from wallet_ledger`.execute(
      ctx.db,
    );
    expect(ledger.rows[0]?.n ?? 0).toBe(0);
    const allocations = await sql<{ n: number }>`
      select count(*)::int as n from payment_allocation where status = 'SETTLED'
    `.execute(ctx.db);
    expect(allocations.rows[0]?.n).toBe(0);
    const status = await getSePayReconciliationStatus(ctx.db, new Date("2026-01-01T00:10:30.000Z"));
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.stale).toBe(false);
  });
});
