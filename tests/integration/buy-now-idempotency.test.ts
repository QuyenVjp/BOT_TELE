import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { sql } from "kysely";
import { createBuyNowCallbackCodec } from "../../src/bot/callback-codec.js";
import { createCatalogCallbacks } from "../../src/bot/callbacks/catalog.js";
import { createCheckoutCallbacks } from "../../src/bot/callbacks/checkout.js";
import { dispatchTelegramBuyNow } from "../../src/bot/callbacks/telegram-dispatch.js";
import { createDb, type DbHandle } from "../../src/infrastructure/db/client.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import { presentPaymentForOrder } from "../../src/modules/payments/service.js";
import { generateOrderPaymentCode } from "../../src/modules/payments/payment-code.js";
import { createSearchParser } from "../../src/modules/catalog/search-parser-adapter.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const CALLBACK_KEY = "test-only-buy-now-callback-key-material-v1";
const TELEGRAM_USER_ID = "1234567890123456789";
const DISPATCH_TELEGRAM_USER_ID = "123456789";

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
  await sql`
    truncate table outbox_event, payment_intent, order_transition, digital_asset, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

interface Seed {
  customerId: string;
  variantId: string;
  otherVariantId: string;
  price: number;
}

async function seed(): Promise<Seed> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const otherVariantId = newId();
  const price = 199_000;
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
       stock_policy, resale_evidence_id)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V1', ${price}, 'P1M', 'CREDENTIAL',
       'LOCAL_ONLY', 'RES-1'),
      (${otherVariantId}, ${productId}, ${"SKU-" + otherVariantId}, 'V2', ${price + 1}, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-2')
  `.execute(ctx.db);
  for (const id of [newId(), newId(), newId()]) {
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${id}, ${variantId}, 'LOCAL', ${"vault:" + id}, ${"fp-" + id}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  const otherAssetId = newId();
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${otherAssetId}, ${otherVariantId}, 'LOCAL', ${"vault:" + otherAssetId},
      ${"fp-" + otherAssetId}, 'AVAILABLE')
  `.execute(ctx.db);
  return { customerId, variantId, otherVariantId, price };
}

function checkout(db: DbHandle["db"], customerId: string) {
  return createCheckoutCallbacks({
    db,
    merchant: {
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
    },
    callbackCodec: createBuyNowCallbackCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    }),
    resolveCustomerId: async (telegramUserId) =>
      telegramUserId === TELEGRAM_USER_ID ? customerId : null,
  });
}

async function counts() {
  const result = await sql<{
    orders: number;
    reservations: number;
    intents: number;
    transitions: number;
  }>`
    select
      (select count(*)::int from "order") as orders,
      (select count(*)::int from digital_asset where status in ('RESERVED','READY')) as reservations,
      (select count(*)::int from payment_intent where status in ('CREATED','PRESENTED')) as intents,
      (select count(*)::int from order_transition where reason_code = 'BUY_NOW') as transitions
  `.execute(ctx.db);
  return result.rows[0]!;
}

describe("Buy Now idempotency and callback safety (T158/T159/T160)", () => {
  it("collapses two simultaneous same-nonce calls across two database handles", async () => {
    const s = await seed();
    const codec = createBuyNowCallbackCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const token = codec.issue({
      telegramUserId: TELEGRAM_USER_ID,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      nonce: new Uint8Array(8).fill(3),
    });
    const checkoutA = checkout(ctx.db, s.customerId);
    const checkoutB = checkout(second.db, s.customerId);
    const [a, b] = await Promise.all([
      checkoutA.buyNowFromCallback({
        callbackData: token,
        telegramUserId: TELEGRAM_USER_ID,
        correlationId: "double-a",
      }),
      checkoutB.buyNowFromCallback({
        callbackData: token,
        telegramUserId: TELEGRAM_USER_ID,
        correlationId: "double-b",
      }),
    ]);
    expect(a.text).toBe(b.text);
    expect(checkoutA.lastOrderNumber()).toBe(checkoutB.lastOrderNumber());
    expect(checkoutA.lastTransferContent()).toBe(checkoutB.lastTransferContent());
    expect(await counts()).toEqual({ orders: 1, reservations: 1, intents: 1, transitions: 1 });
  });

  it("fails closed when the same idempotency key is replayed with a different fingerprint", async () => {
    const s = await seed();
    const key = "buy:v1:fingerprint-conflict";
    const first = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: key,
      correlationId: "fingerprint-first",
    });
    expect(first.ok).toBe(true);
    const replay = await buyNow(second.db, {
      customerId: s.customerId,
      variantId: s.otherVariantId,
      expectedPriceVnd: s.price + 1,
      idempotencyKey: key,
      correlationId: "fingerprint-conflict",
    });
    expect(replay).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await counts()).toMatchObject({ orders: 1, reservations: 1, transitions: 1 });
  });

  it("keeps different valid nonces independent", async () => {
    const s = await seed();
    const [a, b] = await Promise.all([
      buyNow(ctx.db, {
        customerId: s.customerId,
        variantId: s.variantId,
        expectedPriceVnd: s.price,
        idempotencyKey: "buy:v1:nonce-a",
        correlationId: "nonce-a",
      }),
      buyNow(second.db, {
        customerId: s.customerId,
        variantId: s.variantId,
        expectedPriceVnd: s.price,
        idempotencyKey: "buy:v1:nonce-b",
        correlationId: "nonce-b",
      }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await counts()).toMatchObject({ orders: 2, reservations: 2, transitions: 2 });
  });

  it("keeps independent nonce checkout free of stock-trigger deadlocks", async () => {
    const s = await seed();
    await sql`update product_variant set low_stock_threshold = 1 where id = ${s.variantId}`.execute(
      ctx.db,
    );

    const [a, b] = await Promise.all([
      buyNow(ctx.db, {
        customerId: s.customerId,
        variantId: s.variantId,
        expectedPriceVnd: s.price,
        idempotencyKey: "buy:v1:low-stock-deadlock-a",
        correlationId: "low-stock-deadlock-a",
      }),
      buyNow(second.db, {
        customerId: s.customerId,
        variantId: s.variantId,
        expectedPriceVnd: s.price,
        idempotencyKey: "buy:v1:low-stock-deadlock-b",
        correlationId: "low-stock-deadlock-b",
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await counts()).toMatchObject({ orders: 2, reservations: 2, transitions: 2 });
  });

  it("returns one live intent and identical transfer content under rapid presentation", async () => {
    const s = await seed();
    const order = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy:v1:payment-race",
      correlationId: "payment-race-order",
    });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    const input = {
      orderId: order.order.id,
      merchantAccountId: "0123456789",
      beneficiaryAccountNumber: "9876543210",
      bankBin: "970422",
      accountName: "SHOP DIGITAL MVP",
      bankName: "MB Bank",
      correlationId: "payment-race",
    };
    const [a, b] = await Promise.all([
      presentPaymentForOrder(ctx.db, input),
      presentPaymentForOrder(second.db, input),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.intentId).toBe(b.intentId);
    expect(a.presentation.transferContent).toBe(b.presentation.transferContent);
    expect(await counts()).toMatchObject({ intents: 1 });
  });

  it("does not swallow a transfer-content collision owned by another order", async () => {
    const s = await seed();
    const first = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy:v1:content-owner-a",
      correlationId: "content-owner-a",
    });
    const secondOrder = await buyNow(ctx.db, {
      customerId: s.customerId,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      idempotencyKey: "buy:v1:content-owner-b",
      correlationId: "content-owner-b",
    });
    expect(first.ok && secondOrder.ok).toBe(true);
    if (!first.ok || !secondOrder.ok) return;
    const collidingContent = generateOrderPaymentCode(secondOrder.order.orderNumber);
    await sql`
      insert into payment_intent
        (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at,
         presented_at)
      values
        (${newId()}, ${first.order.id}, 'PRESENTED', ${s.price}, '0123456789',
         ${collidingContent}, now() + interval '15 minutes', now())
    `.execute(ctx.db);
    const before = await counts();

    await expect(
      presentPaymentForOrder(second.db, {
        orderId: secondOrder.order.id,
        merchantAccountId: "0123456789",
        beneficiaryAccountNumber: "9876543210",
        bankBin: "970422",
        accountName: "SHOP DIGITAL MVP",
        bankName: "MB Bank",
        correlationId: "content-collision",
      }),
    ).rejects.toThrow("did not belong to this order");
    expect(await counts()).toEqual(before);
  });

  it("carries a signed catalog button through Telegram dispatch without a forgeable customer id", async () => {
    const s = await seed();
    const callbackCodec = createBuyNowCallbackCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const catalog = createCatalogCallbacks({
      db: ctx.db,
      parser: createSearchParser({ driver: "deterministic", timeoutMs: 100 }),
      callbackCodec,
    });
    const detail = await catalog.variantDetail(s.variantId, DISPATCH_TELEGRAM_USER_ID);
    const callbackData = detail.buttons
      .flat()
      .find((button) => button.callbackData.startsWith("buy:"))?.callbackData;
    expect(callbackData).toBeTruthy();

    const dispatched = await dispatchTelegramBuyNow(
      {
        update_id: 42,
        callback_query: {
          id: "callback-query-42",
          from: { id: Number(DISPATCH_TELEGRAM_USER_ID) },
          data: callbackData!,
        },
      },
      createCheckoutCallbacks({
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
          telegramUserId === DISPATCH_TELEGRAM_USER_ID ? s.customerId : null,
      }),
    );
    expect(dispatched.handled).toBe(true);
    if (dispatched.handled) expect(dispatched.message.text).toContain("199.000");
    expect(await counts()).toEqual({ orders: 1, reservations: 1, intents: 1, transitions: 1 });
  });

  it("creates no commerce state for tampered, expired, wrong-action, wrong-user, or malformed callbacks", async () => {
    const s = await seed();
    const c = createBuyNowCallbackCodec({
      key: CALLBACK_KEY,
      keyVersion: 1,
      ttlSeconds: 1,
      clockSkewSeconds: 0,
    });
    const valid = c.issue({
      telegramUserId: TELEGRAM_USER_ID,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      nonce: new Uint8Array(8).fill(5),
    });
    const wrongAction = Buffer.from(valid.slice(4), "base64url");
    wrongAction[0] = (wrongAction[0]! & 0xcf) | 0x20;
    const expired = c.issue({
      telegramUserId: TELEGRAM_USER_ID,
      variantId: s.variantId,
      expectedPriceVnd: s.price,
      now: new Date(Date.now() - 10_000),
      nonce: new Uint8Array(8).fill(6),
    });
    const attempts = [
      {
        callbackData: valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A"),
        user: TELEGRAM_USER_ID,
      },
      { callbackData: expired, user: TELEGRAM_USER_ID },
      { callbackData: `buy:${wrongAction.toString("base64url")}`, user: TELEGRAM_USER_ID },
      { callbackData: valid, user: "999" },
      { callbackData: "malformed", user: TELEGRAM_USER_ID },
    ];
    for (const attempt of attempts) {
      const message = await checkout(ctx.db, s.customerId).buyNowFromCallback({
        callbackData: attempt.callbackData,
        telegramUserId: attempt.user,
        correlationId: "invalid-callback",
      });
      expect(message.text.length).toBeGreaterThan(0);
    }
    expect(await counts()).toEqual({ orders: 0, reservations: 0, intents: 0, transitions: 0 });
  });
});
