import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createApp } from "../../src/app.js";
import { createInMemoryUpdateInbox } from "../../src/bot/webhook.js";
import { newId } from "../../src/shared/ids/index.js";
import { dockerAvailable, startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const botToken = randomBytes(32).toString("hex");
const hasDocker = await dockerAvailable();
let ctx: PgTestContext;
let app: FastifyInstance;

function signedInitData(telegramUserId: number): string {
  const values = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${telegramUserId}`,
    user: JSON.stringify({ id: telegramUserId }),
  });
  const check = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  values.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return values.toString();
}

beforeAll(async () => {
  if (!hasDocker) return;
  ctx = await startPostgresContainer();
  app = await createApp({
    db: ctx.db,
    vault: {
      async write() {
        return "vault:test";
      },
      async reveal() {
        return "test";
      },
      async delete() {},
      async health() {},
    },
    telegram: {
      path: "/__test__/telegram",
      secretToken: "test-secret",
      inbox: createInMemoryUpdateInbox(),
    },
    sepay: {
      path: "/__test__/sepay",
      handler: async () => ({ status: 400, body: { ok: false } }),
    },
    miniApp: { path: "/shop", botToken, maxAgeSeconds: 300 },
    bodyLimitBytes: 1_000_000,
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

beforeEach(async () => {
  if (!hasDocker) return;
  await sql`
    truncate table wallet_ledger, wallet_account, payment_intent, order_transition,
      digital_asset, "order", channel_identity, product_variant, product_alias, product,
      category, customer cascade
  `.execute(ctx.db);
});

async function seedCatalog(): Promise<{ variantId: string; price: number }> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const assetId = newId();
  const price = 100000;
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', ${categoryId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${productId.slice(-8)}, true, 1)`.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       warranty_days, stock_policy, resale_evidence_id, is_active, sort_order)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'Premium 1 tháng', ${price},
      'P1M', 'CREDENTIAL', 30, 'LOCAL_ONLY', 'RES-MINIAPP', true, 1)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
  `.execute(ctx.db);
  return { variantId, price };
}

async function customerIdFor(telegramUserId: number): Promise<string> {
  const row = (await sql<{ customer_id: string }>`
    select customer_id from channel_identity
    where channel = 'TELEGRAM' and channel_user_id = ${String(telegramUserId)}
    limit 1
  `.execute(ctx.db)).rows[0];
  if (!row) throw new Error("missing test customer identity");
  return row.customer_id;
}

describe.skipIf(!hasDocker)("Mini App store authenticated flow", () => {
  it("creates a pending order, pays it from wallet, and keeps orders owner-scoped", async () => {
    const ownerInitData = signedInitData(10101);
    const otherInitData = signedInitData(20202);
    const seeded = await seedCatalog();

    const catalog = await app.inject({ method: "GET", url: "/shop/api/catalog", headers: { "x-telegram-init-data": ownerInitData } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      items: [{ id: seeded.variantId, productNameVi: "Netflix", nameVi: "Premium 1 tháng", priceVnd: String(seeded.price) }],
      nextCursor: null,
    });

    const account = await app.inject({ method: "GET", url: "/shop/api/account", headers: { "x-telegram-init-data": ownerInitData } });
    expect(account.statusCode).toBe(200);
    const ownerCustomerId = await customerIdFor(10101);
    await sql`
      insert into wallet_account (id, customer_id, balance_vnd)
      values (${newId()}, ${ownerCustomerId}, 250000)
      on conflict (customer_id) do update set balance_vnd = 250000
    `.execute(ctx.db);

    const created = await app.inject({
      method: "POST",
      url: "/shop/api/orders",
      headers: { "content-type": "application/json", "x-telegram-init-data": ownerInitData },
      payload: JSON.stringify({ variantId: seeded.variantId, expectedPriceVnd: seeded.price, idempotencyKey: "miniapp-order-1" }),
    });
    expect(created.statusCode).toBe(200);
    const order = created.json().order as { id: string; orderNumber: string; status: string };
    expect(order).toMatchObject({ status: "PENDING_PAYMENT" });

    const otherOrders = await app.inject({ method: "GET", url: "/shop/api/orders", headers: { "x-telegram-init-data": otherInitData } });
    expect(otherOrders.statusCode).toBe(200);
    expect(otherOrders.json()).toMatchObject({ ok: true, items: [] });

    const forbiddenPay = await app.inject({
      method: "POST",
      url: `/shop/api/orders/${order.id}/wallet-pay`,
      headers: { "content-type": "application/json", "x-telegram-init-data": otherInitData },
      payload: JSON.stringify({ idempotencyKey: "other-pay" }),
    });
    expect(forbiddenPay.statusCode).toBe(409);
    expect(forbiddenPay.json()).toMatchObject({ ok: false, code: "NOT_OWNED" });

    const paid = await app.inject({
      method: "POST",
      url: `/shop/api/orders/${order.id}/wallet-pay`,
      headers: { "content-type": "application/json", "x-telegram-init-data": ownerInitData },
      payload: JSON.stringify({ idempotencyKey: "owner-pay" }),
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ ok: true, kind: "PAID", orderId: order.id });

    const rows = await sql<{ status: string; balance_vnd: string }>`
      select o.status, w.balance_vnd
      from "order" o join wallet_account w on w.customer_id = o.customer_id
      where o.id = ${order.id}
    `.execute(ctx.db);
    expect(rows.rows[0]).toEqual({ status: "PAID", balance_vnd: "150000" });
  });
});
