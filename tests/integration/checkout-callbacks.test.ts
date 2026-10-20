import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  createBuyNowCallbackCodec,
  createCallbackTokenCodec,
} from "../../src/bot/callback-codec.js";
import {
  createCheckoutCallbacks,
  type CheckoutCallbackDeps,
} from "../../src/bot/callbacks/checkout.js";
import { applyPaymentEvidence } from "../../src/modules/payments/service.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { setStoreModeForTest } from "../../src/modules/commerce/store-mode.js";
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

async function seedCatalog(options: { fulfillmentType?: string } = {}): Promise<Catalog> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const evidenceId = newId();
  const price = 199000;
  const account = "0123456789";
  const slug = "ai";

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
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, fulfillment_type)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', ${evidenceId}, ${options.fulfillmentType ?? "STOCK_ACCOUNT"})
  `.execute(ctx.db);
  // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
  await sql`
    insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
    values (${evidenceId}, ${variantId}, 'OWNER_ATTESTATION', 'TEST-REF-CHECKOUT-CALLBACKS', 'fixture publication evidence', 'test')
  `.execute(ctx.db);
  await sql`
    update product_variant
       set publication_evidence_id = ${evidenceId},
           publication_product_version = 1,
           publication_variant_version = 1,
           published_at = now(),
           published_by = 'test'
     where id = ${variantId}
  `.execute(ctx.db);
  if (options.fulfillmentType === "QUANTITY_STOCK") {
    await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${variantId}, 5)`.execute(
      ctx.db,
    );
  } else {
    // FR-006a: LOCAL_ONLY requires finite stock reserved at Buy Now.
    for (let i = 0; i < 3; i++) {
      const assetId = newId();
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
      `.execute(ctx.db);
    }
  }

  return { customerId, variantId, price, account };
}

function callbacks(catalog: Catalog, extraDeps: Partial<CheckoutCallbackDeps> = {}) {
  const callbackCodec = createBuyNowCallbackCodec({
    key: CALLBACK_KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });
  const tokenCodec = createCallbackTokenCodec({
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
    tokenCodec,
    resolveCustomerId: async (telegramUserId) =>
      telegramUserId === TELEGRAM_USER_ID ? catalog.customerId : null,
    ...extraDeps,
  });
  return {
    ...adapter,
    buyFromSignedCallback: async (correlationId: string) => {
      const preview = await adapter.previewFromCallback({
        callbackData: tokenCodec.issue({
          action: "CHECKOUT_PREVIEW",
          telegramUserId: TELEGRAM_USER_ID,
          resourceId: catalog.variantId,
        }),
        telegramUserId: TELEGRAM_USER_ID,
        correlationId: `${correlationId}-preview`,
      });
      const callbackData = preview.buttons
        .flat()
        .find((button) => button.text === "🏦 VietQR")?.callbackData;
      if (!callbackData)
        throw new Error(`checkout preview did not issue VietQR callback: ${preview.text}`);
      return adapter.buyNowFromCallback({
        callbackData,
        telegramUserId: TELEGRAM_USER_ID,
        correlationId,
      });
    },
  };
}

beforeEach(async () => {
  // `sepay_reconciliation_cursor` is included so the payment-check cooldown cannot leak
  // from one test into the next (it is provider state, not per-order state).
  await sql`truncate table sepay_reconciliation_cursor, outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
  await setStoreModeForTest(ctx.db, "OPEN", "test");
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

  it("Buy Now copy buttons carry native copy_text values and no internal UUID", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    const res = await cb.buyFromSignedCallback("corr-copy");
    const copies = res.buttons.flat().filter((button) => button.copyText);
    expect(copies.map((button) => button.copyText)).toEqual(
      expect.arrayContaining([
        "9876543210",
        cb.lastTransferContent(),
        String(cat.price),
        cb.lastOrderNumber(),
      ]),
    );
    expect(res.text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    expect(res.photo).toBeInstanceOf(Buffer);
  });

  it("wrong customer cannot refresh another customer's payment", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const res = await cb.refresh(orderNumber, "someone-else");
    expect(res.text).toContain("Không tìm thấy đơn hàng");
    expect(res.text.toLowerCase()).not.toContain("đã thanh toán");
  });

  it("expired intent refresh shows the expired screen", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    await sql`update "order" set status = 'EXPIRED' where order_number = ${orderNumber}`.execute(
      ctx.db,
    );
    const res = await cb.refresh(orderNumber, cat.customerId);
    expect(res.text.toLowerCase()).toContain("hết hạn");
    expect(res.buttons.flat().some((button) => button.callbackData.startsWith("pay:reopen:"))).toBe(
      true,
    );
  });

  it("stale checkout preview asks the customer to reopen the product", async () => {
    const cat = await seedCatalog();
    const callbackCodec = createBuyNowCallbackCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const tokenCodec = createCallbackTokenCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 1,
      clockSkewSeconds: 0,
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
      tokenCodec,
      resolveCustomerId: async (telegramUserId) =>
        telegramUserId === TELEGRAM_USER_ID ? cat.customerId : null,
    });
    const stale = tokenCodec.issue({
      action: "CHECKOUT_PREVIEW",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: cat.variantId,
      now: new Date(Date.now() - 60_000),
    });
    const res = await adapter.previewFromCallback({
      callbackData: stale,
      telegramUserId: TELEGRAM_USER_ID,
      correlationId: "corr-stale",
    });
    expect(res.text).toContain("Phiên này đã cũ");
  });

  it("needs-review refresh shows the order number, not the internal id", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-1");
    const orderNumber = cb.lastOrderNumber()!;
    const row = await sql<{ id: string }>`
      select id from "order" where order_number = ${orderNumber}
    `.execute(ctx.db);
    const orderId = row.rows[0]!.id;
    await sql`update "order" set status = 'PAYMENT_NEEDS_REVIEW' where id = ${orderId}`.execute(
      ctx.db,
    );
    const res = await cb.refresh(orderNumber, cat.customerId);
    expect(res.text).toContain(orderNumber);
    expect(res.text).not.toContain(orderId);
    expect(res.text.toLowerCase()).toMatch(/kiểm tra|đối soát/);
  });
});

/**
 * Presentation-layer customization must never change payment truth.
 */
describe("checkout presentation customization", () => {
  async function setOverride(variantId: string, value: string): Promise<void> {
    await sql`update product_variant set presentation_profile = ${value}::jsonb where id = ${variantId}`.execute(
      ctx.db,
    );
  }

  it("applies the variant's stored presentation override", async () => {
    const cat = await seedCatalog();
    await setOverride(cat.variantId, JSON.stringify({ headline: "Thanh toán Netflix Premium" }));
    const cb = callbacks(cat);
    const res = await cb.buyFromSignedCallback("corr-ovr");
    expect(res.text).toContain("Thanh toán Netflix Premium");
    expect(res.text).toContain("199.000");
  });

  it("falls back to the safe default when the stored override is malformed or unsafe", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    const badOverrides = [
      JSON.stringify({ headline: "<script>alert(1)</script>" }),
      JSON.stringify({ headline: "https://evil.example" }),
    ];
    for (const [index, bad] of badOverrides.entries()) {
      await setOverride(cat.variantId, bad);
      const res = await cb.buyFromSignedCallback(`corr-bad-${index}`);
      expect(res.text).toContain(`💳 Thanh toán đơn #${cb.lastOrderNumber()}`);
      expect(res.text).not.toContain("evil.example");
      expect(res.text).not.toContain("<script>");
    }
  });

  it("never lets a stored override change payment truth", async () => {
    const cat = await seedCatalog();
    // Unknown keys fail the strict schema, so the whole override is ignored.
    await setOverride(
      cat.variantId,
      JSON.stringify({ amountVnd: 1, accountNumber: "0000000000", transferContent: "HACK" }),
    );
    const cb = callbacks(cat);
    const res = await cb.buyFromSignedCallback("corr-truth");
    expect(res.text).toContain("199.000");
    expect(res.text).toContain("9876543210");
    expect(res.text).toContain(cb.lastTransferContent()!);
    expect(res.text).not.toContain("HACK");
  });

  it("forwards the quantity the order actually reserved", async () => {
    const cat = await seedCatalog({ fulfillmentType: "QUANTITY_STOCK" });
    const cb = callbacks(cat);
    const bought = await cb.buyFromSignedCallback("corr-qty");
    const orderNumber = cb.lastOrderNumber()!;
    // A single-unit buy stays quiet: no "× 1" noise.
    expect(bought.text).not.toContain("× 1");

    // Simulate a multi-unit reservation on the same order and re-present.
    await sql`
      update quantity_stock_ledger set quantity_delta = -3
      where order_id = (select id from "order" where order_number = ${orderNumber})
        and entry_type = 'RESERVE'
    `.execute(ctx.db);
    const res = await cb.refresh(orderNumber, cat.customerId);
    expect(res.text).toContain("× 3");
  });

  it("refresh reads the internal payment projection", async () => {
    const cat = await seedCatalog();
    const cb = callbacks(cat);
    await cb.buyFromSignedCallback("corr-none");
    const res = await cb.refresh(cb.lastOrderNumber()!, cat.customerId);
    expect(res.text).toContain("Chưa nhận được thanh toán");
    expect(res.text).toContain("199.000");
  });
});
