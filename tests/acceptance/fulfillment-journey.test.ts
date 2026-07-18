import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import {
  presentPaymentForOrder,
  applyPaymentEvidence,
} from "../../src/modules/payments/service.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { revealDeliveryBundle } from "../../src/modules/digital-goods/delivery.js";
import {
  presentDeliveryProcessing,
  presentDeliveryCompleted,
} from "../../src/bot/presenters/delivery.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T064 — Paid-to-delivery acceptance for the local path (FR-013–FR-017, SC-004).
 *
 * Full US3 journey: Buy Now → VietQR → SePay settle → fulfill (local claim +
 * Delivery Bundle) → owner reveal. Timing is captured so SC-004 (paid-to-
 * delivery latency) can be measured against a real container.
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
  account: string;
  bankBin: string;
  accountName: string;
  secret: string;
  vaultRef: string;
  assetId: string;
}

async function seedSellableWithLocalAsset(): Promise<Catalog> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const assetId = newId();
  const price = 199000;
  const account = "0123456789";
  const bankBin = "970422";
  const accountName = "SHOP DIGITAL MVP";
  const secret = "NETFLIX-USER:pass-" + newId().slice(-6);
  const vault = createInMemoryVault();
  const vaultRef = await vault.write(secret);
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${"nf-" + slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-NF-1')
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'AVAILABLE')
  `.execute(ctx.db);

  return {
    customerId,
    variantId,
    price,
    account,
    bankBin,
    accountName,
    secret,
    vaultRef,
    assetId,
  };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, outbox_event, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("US3 fulfillment journey (paid → delivery)", () => {
  it("Buy Now → SePay settle → fulfill local asset → owner reveal (SC-004 timing)", async () => {
    const cat = await seedSellableWithLocalAsset();
    const t0 = Date.now();

    // 1. Buy Now.
    const buy = await buyNow(ctx.db, {
      customerId: cat.customerId,
      variantId: cat.variantId,
      expectedPriceVnd: cat.price,
      idempotencyKey: "buy-" + newId().slice(-10),
      correlationId: "corr-buy",
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;

    // 2. Present payment + settle with SePay evidence.
    const presented = await presentPaymentForOrder(ctx.db, {
      orderId: buy.order.id,
      merchantAccountId: cat.account,
      beneficiaryAccountNumber: cat.account,
      bankBin: cat.bankBin,
      accountName: cat.accountName,
      bankName: "MB Bank",
      correlationId: "corr-present",
    });
    expect(presented.ok).toBe(true);
    if (!presented.ok) return;

    const settle = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence({
        provider: "sepay",
        providerTransactionId: "SEPAY-" + newId(),
        direction: "IN",
        merchantAccountId: cat.account,
        amountVnd: cat.price,
        content: presented.presentation.transferContent,
        reference: "FT-US3",
        transactedAt: new Date(),
        rawHash: "hash-us3",
        correlationId: "corr-settle",
      }),
    );
    expect(settle).toMatchObject({ ok: true, kind: "SETTLED" });
    const paidAt = Date.now();

    // 3. Fulfill: claim local asset + issue Delivery Bundle.
    const vault = createInMemoryVault();
    // Re-write the same material under a known ref so reveal can resolve it.
    // (The seed vault is a different in-memory instance; we pass a reveal
    // adapter that maps the seed vaultRef to the secret.)
    const fulfill = await fulfillPaidOrder(ctx.db, {
      orderId: buy.order.id,
      correlationId: "corr-ful",
      deps: {
        vault,
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      },
    });
    expect(fulfill.ok).toBe(true);
    if (!fulfill.ok) return;
    expect(fulfill.assetId).toBe(cat.assetId);
    expect(fulfill.token.length).toBeGreaterThanOrEqual(32);

    const deliveredAt = Date.now();
    // SC-004: paid-to-delivery wall-clock (container amortized, should be << minutes).
    const paidToDeliveryMs = deliveredAt - paidAt;
    expect(paidToDeliveryMs).toBeLessThan(30_000);

    // Presenters never embed the secret.
    const processing = presentDeliveryProcessing(buy.order.orderNumber);
    expect(processing.text.toLowerCase()).toContain("xử lý");
    const completed = presentDeliveryCompleted(buy.order.orderNumber, fulfill.deliveryUrl);
    expect(completed.text).toContain(fulfill.deliveryUrl);
    expect(completed.text).not.toContain(cat.secret);

    // 4. Owner reveal — secret exactly once.
    const revealVault = {
      reveal: async (ref: string) => {
        if (ref === cat.vaultRef) return cat.secret;
        throw new Error("unknown ref");
      },
    };
    const revealed = await revealDeliveryBundle(ctx.db, {
      token: fulfill.token,
      customerId: cat.customerId,
      correlationId: "corr-reveal",
      vault: revealVault,
    });
    expect(revealed.ok).toBe(true);
    if (revealed.ok) expect(revealed.secret).toBe(cat.secret);

    // Replay reveal fails closed.
    const replay = await revealDeliveryBundle(ctx.db, {
      token: fulfill.token,
      customerId: cat.customerId,
      correlationId: "corr-reveal-2",
      vault: revealVault,
    });
    expect(replay.ok).toBe(false);

    // Asset is DELIVERED; Order MUST be COMPLETED after a successful reveal
    // (T147 — independent review finding: tests previously accepted PROCESSING).
    const asset = await sql<{ status: string }>`
      select status from digital_asset where id = ${cat.assetId}
    `.execute(ctx.db);
    expect(asset.rows[0]?.status).toBe("DELIVERED");
    const order = await sql<{ status: string }>`
      select status from "order" where id = ${buy.order.id}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("COMPLETED");

    const totalMs = Date.now() - t0;
    // Whole journey (excluding container boot) is well under a minute.
    expect(totalMs).toBeLessThan(60_000);
  });
});
