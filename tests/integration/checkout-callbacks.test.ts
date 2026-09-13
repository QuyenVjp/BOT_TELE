import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createBuyNowCallbackCodec } from "../../src/bot/callback-codec.js";
import { createCheckoutCallbacks } from "../../src/bot/callbacks/checkout.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * T056 — Checkout callbacks: Buy Now, payment status refresh, reopen, unpaid-cancel.
 *
 * The callback layer is thin orchestration over buyNow + presentPaymentForOrder +
 * cancelUnpaidOrder + the payments projection. It NEVER polls SePay per click and
 * never marks paid — refresh reads the internal order/intent state only.
 */

let ctx: PgTestContext;
const TELEGRAM_USER_ID = "123456789";
const CALLBACK_KEY = "test-only-checkout-callback-key-material-v1";

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
}

async function seedCatalog(): Promise<Catalog> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const price = 199000;
  const account = "0123456789";
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
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  // FR-006a: LOCAL_ONLY requires finite stock reserved at Buy Now.
  for (let i = 0; i < 3; i++) {
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }

  return { customerId, variantId, price, account };
}

function callbacks(catalog: Catalog) {
  const callbackCodec = createBuyNowCallbackCodec({
    key: CALLBACK_KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
  const adapter = createCheckoutCallbacks({
    db: ctx.db,
    merchant: {
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
    },
    callbackCodec,
    resolveCustomerId: async (telegramUserId) =>
      telegramUserId === TELEGRAM_USER_ID ? catalog.customerId : null,
  });
  return {
    ...adapter,
    buyFromSignedCallback: (correlationId: string) =>
      adapter.buyNowFromCallback({
        callbackData: callbackCodec.issue({
          telegramUserId: TELEGRAM_USER_ID,
          variantId: catalog.variantId,
          expectedPriceVnd: catalog.price,
        }),
        telegramUserId: TELEGRAM_USER_ID,
        correlationId,
      }),
  };
}

beforeEach(async () => {
  await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("checkout callbacks (T056)", () => {
  it("Buy Now creates an order and presents the payment screen", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    const res = await cb.buyFromSignedCallback("corr-1");
    expect(res.text).toContain("199.000");
    expect(res.text.toLowerCase()).toContain("không cần gửi ảnh");
    const data = res.buttons.flat().map((b) => b.callbackData);
    expect(data.some((d) => d.startsWith("pay:refresh:"))).toBe(true);
  });

  it("status refresh reads internal state — still pending before evidence", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    const buy = await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber();
    expect(orderNumber).toBeTruthy();
    const refreshed = await cb.refresh(orderNumber!, cat.customerId);
    // Still waiting — shows pending notice and the payment screen
    expect(refreshed.text).toContain("Chưa nhận được thanh toán");
    expect(refreshed.text).toContain("Hệ thống sẽ tự cập nhật ngay khi ngân hàng xác nhận");
    expect(refreshed.text.toLowerCase()).not.toContain("đã thanh toán");
    expect(buy.text).toContain("199.000");
  });

  it("status refresh reflects a settled order after SePay evidence", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const content = cb.lastTransferContent()!;

    await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence({
        provider: "sepay",
        providerTransactionId: "SEPAY-" + newId(),
        direction: "IN",
        merchantAccountId: cat.account,
        amountVnd: cat.price,
        content,
        reference: "FT-1",
        transactedAt: new Date(),
        rawHash: "hash-1",
        correlationId: "corr-settle",
      }),
    );

    const refreshed = await cb.refresh(orderNumber, cat.customerId);
    expect(refreshed.text.toLowerCase()).toContain("đã thanh toán");
    expect(refreshed.text).toContain("Đang giao sản phẩm...");

    // Completed order wording
    await sql`update "order" set status = 'COMPLETED' where order_number = ${orderNumber}`.execute(
      ctx.db,
    );
    const completed = await cb.refresh(orderNumber, cat.customerId);
    expect(completed.text).toContain("Đơn hàng đã hoàn tất");

    // Manual / unlimited service wording
    await sql`update "order" set status = 'PROCESSING', fulfillment_type = 'UNLIMITED_SERVICE' where order_number = ${orderNumber}`.execute(
      ctx.db,
    );
    const manualProcessing = await cb.refresh(orderNumber, cat.customerId);
    expect(manualProcessing.text).toContain("Đang chờ nhân viên xử lý thủ công");
  });

  it("unpaid cancel transitions the order to CANCELLED", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const res = await cb.cancel(orderNumber, cat.customerId, "corr-cancel");
    expect(res.text.toLowerCase()).toMatch(/đã hu|hu[ỷy]/);
    const cancelledCallbacks = res.buttons.flat().map((b) => b.callbackData);
    expect(cancelledCallbacks.some((d) => d.startsWith("pay:refresh:"))).toBe(false);
    expect(cancelledCallbacks.some((d) => d.startsWith("pay:cancel:"))).toBe(false);
    const status = await sql<{ status: string }>`
      select status from "order" where order_number = ${orderNumber}
    `.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("CANCELLED");
  });

  it("refusing a non-owner cancel is safe (ownership enforced)", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const res = await cb.cancel(orderNumber, "someone-else", "corr-x");
    // Not cancelled; message is a stable Vietnamese error.
    expect(res.text.length).toBeGreaterThan(0);
    const status = await sql<{ status: string }>`
      select status from "order" where order_number = ${orderNumber}
    `.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("PENDING_PAYMENT");
  });

  it("reopen re-presents the payment screen for an unpaid order", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const res = await cb.reopen(orderNumber, cat.customerId);
    expect(res.text).toContain("199.000");
    const data = res.buttons.flat().map((b) => b.callbackData);
    expect(data.some((d) => d.startsWith("pay:refresh:"))).toBe(true);
  });
});
