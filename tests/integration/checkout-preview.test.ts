import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  createBuyNowCallbackCodec,
  createCallbackTokenCodec,
} from "../../src/bot/callback-codec.js";
import { createCheckoutCallbacks } from "../../src/bot/callbacks/checkout.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Checkout confirmation (goal §32) and wallet choice (§41/§42).
 *
 * Opening the confirmation screen must create NO financial state; the VietQR button must
 * still drive the original, proven order+intent path; and the wallet button must debit at
 * most once per purchase intent, with a human shortfall screen when the balance is short.
 */

let ctx: PgTestContext;
const TELEGRAM_USER_ID = "123456789";
const CALLBACK_KEY = "test-only-checkout-preview-callback-key-v1";

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Catalog {
  customerId: string;
  variantId: string;
  productId: string;
  price: string;
}

async function seedCatalog(): Promise<Catalog> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const price = "199000";
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Claude', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, warranty_vi)
    values (${productId}, ${categoryId}, 'Claude Pro', ${slug}, true, 1, 'Bảo hành theo chính sách')
  `.execute(ctx.db);
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, '1 tháng', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  for (let i = 0; i < 3; i++) {
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return { customerId, variantId, productId, price };
}

const buyCodec = () =>
  createBuyNowCallbackCodec({
    key: CALLBACK_KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });

const tokenCodec = () =>
  createCallbackTokenCodec({
    key: CALLBACK_KEY,
    keyVersion: 1,
    ttlSeconds: 900,
    clockSkewSeconds: 5,
  });

function build(catalog: Catalog, balanceVnd: bigint | null) {
  const payOrderWithWallet = vi.fn(
    async (_input: {
      customerId: string;
      orderId: string;
      idempotencyKey: string;
      correlationId: string;
    }) => ({
      ok: true,
      message: "",
    }),
  );
  const adapter = createCheckoutCallbacks({
    db: ctx.db,
    merchant: {
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "TIER20 SHOP",
      bankName: "MB Bank",
    },
    callbackCodec: buyCodec(),
    tokenCodec: tokenCodec(),
    resolveCustomerId: async (telegramUserId) =>
      telegramUserId === TELEGRAM_USER_ID ? catalog.customerId : null,
    resolveAudience: async () => "public",
    walletBalanceVnd: async () => balanceVnd,
    walletTopUpBounds: { minVnd: 50_000n, maxVnd: 1_000_000n },
    payOrderWithWallet,
  });
  const preview = (token: string, telegramUserId = TELEGRAM_USER_ID) =>
    adapter.previewFromCallback({
      callbackData: token,
      telegramUserId,
      correlationId: "t-preview",
    });
  const wallet = (token: string, telegramUserId = TELEGRAM_USER_ID) =>
    adapter.payWithWalletFromCallback({
      callbackData: token,
      telegramUserId,
      correlationId: "t-wallet",
    });
  const previewToken = (variantId = catalog.variantId) =>
    tokenCodec().issue({
      action: "CHECKOUT_PREVIEW",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: variantId,
    });
  const walletToken = (variantId = catalog.variantId, amountVnd = Number(catalog.price)) =>
    tokenCodec().issue({
      action: "CHECKOUT_WALLET",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: variantId,
      amountVnd,
    });
  return { adapter, payOrderWithWallet, preview, wallet, previewToken, walletToken };
}

const orderCount = async () => {
  const r = await sql<{ n: string }>`select count(*)::text as n from "order"`.execute(ctx.db);
  return Number(r.rows[0]!.n);
};
const intentCount = async () => {
  const r = await sql<{ n: string }>`select count(*)::text as n from payment_intent`.execute(
    ctx.db,
  );
  return Number(r.rows[0]!.n);
};

beforeEach(async () => {
  await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
    ctx.db,
  );
});

describe("checkout confirmation screen", () => {
  it("renders the order summary without creating an order or a payment intent", async () => {
    const catalog = await seedCatalog();
    const { preview, previewToken } = build(catalog, null);

    const message = await preview(previewToken());

    expect(message.text).toContain("🛒 XÁC NHẬN ĐƠN HÀNG");
    expect(message.text).toContain("Claude Pro");
    expect(message.text).toContain("1 tháng");
    expect(message.text).toContain("199.000");
    expect(message.buttons.flat().map((b) => b.text)).toEqual([
      "🏦 VietQR",
      "👛 Ví TIER20",
      "❌ Huỷ",
    ]);
    expect(await orderCount()).toBe(0);
    expect(await intentCount()).toBe(0);
  });

  it("hands the VietQR button a Buy Now token the proven path accepts", async () => {
    const catalog = await seedCatalog();
    const { preview, previewToken, adapter } = build(catalog, null);

    const message = await preview(previewToken());
    const qr = message.buttons.flat().find((b) => b.text === "🏦 VietQR")!;
    expect(qr.callbackData.startsWith("buy:")).toBe(true);

    const paid = await adapter.buyNowFromCallback({
      callbackData: qr.callbackData,
      telegramUserId: TELEGRAM_USER_ID,
      correlationId: "t-qr",
    });
    expect(paid.text).toContain("Thanh toán đơn hàng");
    expect(await orderCount()).toBe(1);
    expect(await intentCount()).toBe(1);
  });

  it("rejects a token minted for another customer", async () => {
    const catalog = await seedCatalog();
    const { preview, previewToken } = build(catalog, null);

    const message = await preview(previewToken(), "999");
    expect(message.text).toContain("Phiên này đã cũ");
    expect(await orderCount()).toBe(0);
  });

  it("refuses a stale or unrelated token instead of opening a checkout", async () => {
    const catalog = await seedCatalog();
    const { preview } = build(catalog, null);
    const message = await preview("cb:not-a-real-token");
    expect(message.text).toContain("Phiên này đã cũ");
    expect(await orderCount()).toBe(0);
  });
});

describe("wallet choice", () => {
  it("shows the exact shortfall and creates nothing when the balance is short", async () => {
    const catalog = await seedCatalog();
    const { wallet, walletToken, payOrderWithWallet } = build(catalog, 50_000n);

    const message = await wallet(walletToken());

    expect(message.text).toContain("SỐ DƯ VÍ KHÔNG ĐỦ");
    expect(message.text).toContain("149.000");
    expect(message.text).toContain("Còn thiếu");
    // formatVnd separates the amount from ₫ with a non-breaking space.
    const labels = message.buttons.flat().map((b) => b.text.replace(/\u00a0/g, " "));
    expect(labels).toContain("⚡ Nạp thêm 149.000 ₫");
    expect(labels).toContain("🏦 Thanh toán VietQR");
    expect(await orderCount()).toBe(0);
    expect(payOrderWithWallet).not.toHaveBeenCalled();
  });

  it("refuses to charge a price the customer did not confirm", async () => {
    const catalog = await seedCatalog();
    const { wallet, walletToken, payOrderWithWallet } = build(catalog, 500_000n);

    // The token carries the price the confirmation screen showed; the live row now costs more.
    await sql`update product_variant set price_vnd = 249000 where id = ${catalog.variantId}`.execute(
      ctx.db,
    );

    const message = await wallet(walletToken(catalog.variantId, Number(catalog.price)));

    expect(message.text).toContain("Giá sản phẩm vừa thay đổi");
    expect(await orderCount()).toBe(0);
    expect(payOrderWithWallet).not.toHaveBeenCalled();
  });

  it("creates one order and debits once, even when the button is tapped twice", async () => {
    const catalog = await seedCatalog();
    const { wallet, walletToken, payOrderWithWallet } = build(catalog, 500_000n);

    const first = await wallet(walletToken());
    expect(first.text).toContain("Đã thanh toán bằng ví");
    const second = await wallet(walletToken());

    expect(await orderCount()).toBe(1);
    expect(payOrderWithWallet).toHaveBeenCalledTimes(2);
    // The same order id both times: the deterministic wallet key short-circuits buyNow.
    const orderIds = payOrderWithWallet.mock.calls.map(
      (call) => (call[0] as { orderId: string }).orderId,
    );
    expect(new Set(orderIds).size).toBe(1);
    expect(second.text).toContain("Đã thanh toán bằng ví");
  });
});
