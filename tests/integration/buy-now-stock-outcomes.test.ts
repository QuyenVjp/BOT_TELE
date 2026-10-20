import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createCheckoutCallbacks } from "../../src/bot/callbacks/checkout.js";
import {
  createBuyNowCallbackCodec,
  createCallbackTokenCodec,
} from "../../src/bot/callback-codec.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { setStoreModeForTest } from "../../src/modules/commerce/store-mode.js";

let ctx: PgTestContext;
const TELEGRAM_USER_ID = "123456789";
const CALLBACK_KEY = "test-only-stock-callback-key-material-v1";

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table outbox_event, payment_intent, order_transition, digital_asset, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
  await sql`drop function if exists test_lose_reservation() cascade`.execute(ctx.db);
  await setStoreModeForTest(ctx.db, "OPEN", "test");
});

interface Seed {
  customerId: string;
  variantId: string;
  assetId: string | null;
  price: number;
}

async function seed(withAsset: boolean): Promise<Seed> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const assetId = withAsset ? newId() : null;
  const price = 199000;
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
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id, fulfillment_type)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', ${price}, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', 'STOCK_ACCOUNT')
  `.execute(ctx.db);
  await sql`
    insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
    values ('RES-1', ${variantId}, 'OWNER_ATTESTATION', 'TEST-REF', 'fixture publication evidence', 'test')
  `.execute(ctx.db);
  await sql`
    update product_variant
       set publication_evidence_id = resale_evidence_id,
           publication_product_version = 1,
           publication_variant_version = 1,
           published_at = now(),
           published_by = 'test'
     where id = ${variantId}
  `.execute(ctx.db);
  if (assetId) {
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return { customerId, variantId, assetId, price };
}

async function renderBuyCallback(seed: Seed, correlationId: string) {
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
  const callbacks = createCheckoutCallbacks({
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
      telegramUserId === TELEGRAM_USER_ID ? seed.customerId : null,
  });
  const preview = await callbacks.previewFromCallback({
    callbackData: tokenCodec.issue({
      action: "CHECKOUT_PREVIEW",
      telegramUserId: TELEGRAM_USER_ID,
      resourceId: seed.variantId,
    }),
    telegramUserId: TELEGRAM_USER_ID,
    correlationId: `${correlationId}-preview`,
  });
  const callbackData = preview.buttons
    .flat()
    .find((button) => button.text === "🏦 VietQR")?.callbackData;
  if (!callbackData) throw new Error("checkout preview did not issue VietQR callback");
  return { callbacks, callbackData, correlationId };
}
async function buyFromSignedCallback(seed: Seed, correlationId: string) {
  const flow = await renderBuyCallback(seed, correlationId);
  return flow.callbacks.buyNowFromCallback({
    callbackData: flow.callbackData,
    telegramUserId: TELEGRAM_USER_ID,
    correlationId,
  });
}

async function assertNoOrphans(): Promise<void> {
  const rows = await sql<{ orders: number; intents: number }>`
    select
      (select count(*)::int from "order") as orders,
      (select count(*)::int from payment_intent) as intents
  `.execute(ctx.db);
  expect(rows.rows[0]).toEqual({ orders: 0, intents: 0 });
}

describe("checkout typed stock outcomes", () => {
  it("renders NO_STOCK copy once when stock disappears after preview", async () => {
    const s = await seed(true);
    const flow = await renderBuyCallback(s, "stock-empty");
    await sql`delete from digital_asset where id = ${s.assetId}`.execute(ctx.db);
    const msg = await flow.callbacks.buyNowFromCallback({
      callbackData: flow.callbackData,
      telegramUserId: TELEGRAM_USER_ID,
      correlationId: "stock-empty",
    });
    expect(msg.text).toBe(
      "Sản phẩm hiện đã hết hàng. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
    );
    await assertNoOrphans();
  });

  it("renders CONTENTION_TIMEOUT copy once while the only unit remains locked", async () => {
    const s = await seed(true);
    const client = await ctx.handle.pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from digital_asset where id = $1 for update", [s.assetId]);
      const msg = await buyFromSignedCallback(s, "stock-contended");
      expect(msg.text).toBe(
        "Đang có nhiều người đặt sản phẩm này. Vui lòng thử lại sau vài giây. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
      );
      await assertNoOrphans();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("renders RESERVATION_LOST copy once when the guarded reservation update loses", async () => {
    const s = await seed(true);
    await sql`
      create function test_lose_reservation() returns trigger language plpgsql as $$
      begin
        if old.status = 'AVAILABLE' and new.status = 'RESERVED' then
          return null;
        end if;
        return new;
      end $$
    `.execute(ctx.db);
    await sql`
      create trigger test_lose_reservation_trigger before update on digital_asset
      for each row execute function test_lose_reservation()
    `.execute(ctx.db);

    const msg = await buyFromSignedCallback(s, "stock-lost");
    expect(msg.text).toBe(
      "Sản phẩm cuối vừa được khách khác đặt trước. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
    );
    await assertNoOrphans();
  });
});
