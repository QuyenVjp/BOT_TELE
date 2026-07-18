import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createApp } from "../../src/app.js";
import { createInMemoryUpdateInbox } from "../../src/bot/webhook.js";
import {
  createPostgresSePayInbox,
  processSePayInboxBatch,
} from "../../src/infrastructure/inbox/sepay.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import {
  applyPaymentEvidence,
  presentPaymentForOrder,
} from "../../src/modules/payments/service.js";
import { createSePayIngressHandler } from "../../src/modules/payments/sepay-ingress.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T045 — End-to-end Buy Now → VietQR → SePay settlement (User Story 2).
 *
 * A customer picks a sellable variant, taps Buy Now, is presented a VietQR with
 * exact amount + unique transfer content, and a verified SePay inbound transfer
 * settles the order exactly once. VietQR never asserts settlement; only SePay
 * evidence does.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Catalog {
  customerId: string;
  variantId: string;
  price: number;
  merchantAccountId: string;
  beneficiaryAccountNumber: string;
  bankBin: string;
  accountName: string;
}

async function seedCatalog(options: { sameAccount?: boolean } = {}): Promise<Catalog> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const price = 199000;
  const beneficiaryAccountNumber = "0123456789";
  const merchantAccountId = options.sameAccount ? beneficiaryAccountNumber : "sepay-merchant-001";
  const bankBin = "970422";
  const accountName = "SHOP DIGITAL MVP";

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', 'giai-tri', true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', 'netflix', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-NF-1')
  `.execute(ctx.db);
  // FR-006a: LOCAL_ONLY requires finite stock reserved at Buy Now.
  const assetId = newId();
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
  `.execute(ctx.db);

  return {
    customerId,
    variantId,
    price,
    merchantAccountId,
    beneficiaryAccountNumber,
    bankBin,
    accountName,
  };
}

beforeEach(async () => {
  await sql`truncate table webhook_inbox, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("US2 payment journey (Buy Now → VietQR → SePay settle)", () => {
  it("creates an unpaid order, presents VietQR, and settles on verified evidence", async () => {
    const cat = await seedCatalog();

    // 1. Buy Now — revalidates sellability, captures immutable snapshot.
    const buy = await buyNow(ctx.db, {
      customerId: cat.customerId,
      variantId: cat.variantId,
      expectedPriceVnd: cat.price,
      idempotencyKey: "buy-" + newId().slice(-10),
      correlationId: "corr-buy-1",
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    expect(buy.order.status).toBe("PENDING_PAYMENT");
    expect(buy.order.priceVnd).toBe(String(cat.price));

    // 2. Present payment — create PaymentIntent + VietQR payload (initiation only).
    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: buy.order.id,
      merchantAccountId: cat.merchantAccountId,
      beneficiaryAccountNumber: cat.beneficiaryAccountNumber,
      bankBin: cat.bankBin,
      accountName: cat.accountName,
      bankName: "MB Bank",
      correlationId: "corr-present-1",
    });
    expect(presented.ok).toBe(true);
    if (!presented.ok) return;
    expect(presented.presentation.amountVnd).toBe(cat.price);
    expect(presented.presentation.transferContent.length).toBeGreaterThan(0);
    expect(presented.presentation.payload.startsWith("0002")).toBe(true); // EMVCo TLV
    expect(presented.presentation.orderNumber).toBe(buy.order.orderNumber);
    expect(presented.presentation.accountNumber).toBe(cat.beneficiaryAccountNumber);
    expect(presented.presentation.bankName).toBe("MB Bank");
    // Presentation deliberately carries NO settlement flag.
    expect("settled" in presented.presentation).toBe(false);

    // Intent is PRESENTED and linked to the order.
    const intent = await sql<{ status: string; amount_vnd: string }>`
      select status, amount_vnd from payment_intent where id = ${presented.intentId}
    `.execute(ctx.db);
    expect(intent.rows[0]?.status).toBe("PRESENTED");
    expect(Number(intent.rows[0]?.amount_vnd)).toBe(cat.price);

    // 3. SePay evidence arrives (verified inbound, exact match).
    const settle = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence({
        provider: "sepay",
        providerTransactionId: "SEPAY-" + newId(),
        direction: "IN",
        merchantAccountId: cat.merchantAccountId,
        amountVnd: cat.price,
        content: presented.presentation.transferContent,
        reference: "FT-ACCEPT-1",
        transactedAt: new Date(),
        rawHash: "hash-accept-1",
        correlationId: "corr-settle-1",
      }),
    );
    expect(settle).toMatchObject({ ok: true, kind: "SETTLED" });

    // 4. Order is PAID, intent SUCCEEDED, exactly one settlement pipeline.
    const order = await sql<{ status: string; paid_at: string | null }>`
      select status, paid_at from "order" where id = ${buy.order.id}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAID");
    expect(order.rows[0]?.paid_at).toBeTruthy();

    const settledIntent = await sql<{ status: string; settled_at: string | null }>`
      select status, settled_at from payment_intent where id = ${presented.intentId}
    `.execute(ctx.db);
    expect(settledIntent.rows[0]?.status).toBe("SUCCEEDED");
    expect(settledIntent.rows[0]?.settled_at).toBeTruthy();

    const events = await sql<{ event_type: string }>`
      select event_type from outbox_event order by event_type
    `.execute(ctx.db);
    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain("PaymentSettled");
    expect(types).toContain("OrderPaid");
  });

  it.each([
    { label: "same pilot account", sameAccount: true, subAccount: null },
    { label: "distinct SePay identity with VA", sameAccount: false, subAccount: "VA-001" },
  ])(
    "accepts $label through Fastify commit, ACK, worker, and settlement",
    async ({ sameAccount, subAccount }) => {
      const cat = await seedCatalog({ sameAccount });
      const buy = await buyNow(ctx.db, {
        customerId: cat.customerId,
        variantId: cat.variantId,
        expectedPriceVnd: cat.price,
        idempotencyKey: "buy-http-" + newId().slice(-10),
        correlationId: "corr-http-buy",
      });
      expect(buy.ok).toBe(true);
      if (!buy.ok) return;
      const presented = await presentPaymentForOrder(ctx.db, {
        orderId: buy.order.id,
        merchantAccountId: cat.merchantAccountId,
        beneficiaryAccountNumber: cat.beneficiaryAccountNumber,
        bankBin: cat.bankBin,
        accountName: cat.accountName,
        bankName: "MB Bank",
        correlationId: "corr-http-present",
      });
      expect(presented.ok).toBe(true);
      if (!presented.ok) return;

      const now = new Date();
      const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const transactionDate = local.toISOString().slice(0, 19).replace("T", " ");
      const rawBody = JSON.stringify({
        id: 987654,
        gateway: "MBBank",
        transactionDate,
        accountNumber: cat.merchantAccountId,
        subAccount,
        code: presented.presentation.transferContent,
        content: "ORD payment",
        transferType: "in",
        description: "ORD payment",
        transferAmount: cat.price,
        accumulated: cat.price,
        referenceCode: "FT-HTTP-987654",
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const hmacFixture = ["test", "only", "sepay", "http", "acceptance", "key", "123456"].join(
        "-",
      );
      const telegramWebhookFixture = ["test", "telegram", "webhook", "fixture"].join("-");
      const signature = `sha256=${createHmac("sha256", hmacFixture)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex")}`;
      const sepayInbox = createPostgresSePayInbox(ctx.db);
      const app = await createApp({
        db: ctx.db,
        vault: {
          write: vi.fn(),
          reveal: vi.fn(),
          delete: vi.fn(),
        } as unknown as Vault,
        telegram: {
          path: "/telegram/webhook",
          secretToken: telegramWebhookFixture,
          inbox: createInMemoryUpdateInbox(),
        },
        sepay: {
          path: "/webhooks/sepay",
          handler: createSePayIngressHandler({
            hmacSecret: hmacFixture,
            replayWindowSeconds: 300,
            ipAllowlist: ["172.236.138.20"],
            trustedProxyIps: [],
            inbox: sepayInbox,
          }),
        },
        bodyLimitBytes: 65536,
        logger: false,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/webhooks/sepay",
          headers: {
            "content-type": "application/json",
            "x-sepay-timestamp": timestamp,
            "x-sepay-signature": signature,
          },
          remoteAddress: "172.236.138.20",
          payload: rawBody,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('{"success":true}');
        expect(response.json()).toEqual({ success: true });
        const inboxRow = await sql<{ status: string; raw_hash: string }>`
        select processing_status as status, raw_hash from webhook_inbox
        where source = 'sepay' and source_event_id = '987654'
      `.execute(ctx.db);
        expect(inboxRow.rows[0]?.status).toBe("RETRY");
        expect(inboxRow.rows[0]?.raw_hash).toMatch(/^[a-f0-9]{64}$/);

        const worker = await processSePayInboxBatch({
          inbox: sepayInbox,
          owner: "sepay-acceptance-worker",
          batchSize: 10,
          handler: (evidence) => applyPaymentEvidence(ctx.db, evidence),
        });
        expect(worker).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
        const settled = await sql<{
          status: string;
        }>`select status from "order" where id = ${buy.order.id}`.execute(ctx.db);
        expect(settled.rows[0]?.status).toBe("PAID");
      } finally {
        await app.close();
      }
    },
  );

  it("Buy Now double-tap is idempotent (same order, one intent)", async () => {
    const cat = await seedCatalog();
    const key = "buy-double-" + newId().slice(-8);
    const first = await buyNow(ctx.db, {
      customerId: cat.customerId,
      variantId: cat.variantId,
      expectedPriceVnd: cat.price,
      idempotencyKey: key,
      correlationId: "corr-1",
    });
    const second = await buyNow(ctx.db, {
      customerId: cat.customerId,
      variantId: cat.variantId,
      expectedPriceVnd: cat.price,
      idempotencyKey: key,
      correlationId: "corr-2",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.order.id).toBe(first.order.id);

    // Presenting twice for the same order reuses the live intent (unique active intent).
    const p1 = await presentPaymentForOrder(ctx.db, {
      orderId: first.order.id,
      merchantAccountId: cat.merchantAccountId,
      beneficiaryAccountNumber: cat.beneficiaryAccountNumber,
      bankBin: cat.bankBin,
      accountName: cat.accountName,
      bankName: "MB Bank",
      correlationId: "corr-p1",
    });
    const p2 = await presentPaymentForOrder(ctx.db, {
      orderId: first.order.id,
      merchantAccountId: cat.merchantAccountId,
      beneficiaryAccountNumber: cat.beneficiaryAccountNumber,
      bankBin: cat.bankBin,
      accountName: cat.accountName,
      bankName: "MB Bank",
      correlationId: "corr-p2",
    });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect(p2.intentId).toBe(p1.intentId);
    expect(p2.presentation.transferContent).toBe(p1.presentation.transferContent);

    const intentCount = await sql<{ count: string }>`
      select count(*)::text as count from payment_intent where order_id = ${first.order.id}
    `.execute(ctx.db);
    expect(Number(intentCount.rows[0]?.count)).toBe(1);
  });
});
