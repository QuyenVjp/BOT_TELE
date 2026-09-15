import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { buyNow, isStoreOpen } from "../../src/modules/commerce/buy-now.js";
import { setStoreModeForTest } from "../../src/modules/commerce/store-mode.js";
import { createWalletPurchaseService } from "../../src/modules/wallet/purchase.js";
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
    truncate table outbox_event, payment_intent, order_transition, digital_asset, "order",
      product_variant, product, category, customer, store_control cascade
  `.execute(ctx.db);
  await sql`
    insert into store_control (id, status, updated_at, updated_by)
    values ('main', 'CLOSED', now(), 'system')
    on conflict (id) do update set status = 'CLOSED'
  `.execute(ctx.db);
});

describe("global store kill-switch enforcement", () => {
  it("denies customer buyNow when store is CLOSED even if product and variant are active", async () => {
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const price = 2000;

    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', 'cat', true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Active Product', 'active-prod', true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, is_active)
      values (${variantId}, ${productId}, 'ACTIVE-SKU', 'V1', ${price}, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', true)
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

    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', 'vault:ref', 'fp-hash', 'AVAILABLE')
    `.execute(ctx.db);

    // Verify store is CLOSED
    expect(await isStoreOpen(ctx.db)).toBe(false);

    // Customer attempt to buy
    const denied = await buyNow(ctx.db, {
      customerId,
      variantId,
      expectedPriceVnd: price,
      idempotencyKey: "buy:store-closed:1",
      correlationId: "corr-store-closed-1",
    });

    expect(denied).toMatchObject({
      ok: false,
      code: "STORE_CLOSED",
      message: "Cửa hàng hiện đang tạm đóng cửa. Vui lòng quay lại sau.",
    });

    // Check no order, no payment intent, no reservation was created
    const counts = await sql<{ orders: number; intents: number; reserved: number }>`
      select
        (select count(*)::int from "order") as orders,
        (select count(*)::int from payment_intent) as intents,
        (select count(*)::int from digital_asset where status != 'AVAILABLE') as reserved
    `.execute(ctx.db);

    expect(counts.rows[0]).toEqual({ orders: 0, intents: 0, reserved: 0 });

    // When store is opened
    await setStoreModeForTest(ctx.db, "OPEN", "admin");
    expect(await isStoreOpen(ctx.db)).toBe(true);

    const allowed = await buyNow(ctx.db, {
      customerId,
      variantId,
      expectedPriceVnd: price,
      idempotencyKey: "buy:store-open:1",
      correlationId: "corr-store-open-1",
    });

    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.order.status).toBe("PENDING_PAYMENT");
    }

    // When closed again
    await setStoreModeForTest(ctx.db, "CLOSED", "admin");
    expect(await isStoreOpen(ctx.db)).toBe(false);

    // Wallet purchase attempt when closed
    const walletService = createWalletPurchaseService(ctx.db);
    if (allowed.ok) {
      const walletPurchase = await walletService.purchase({
        customerId,
        orderId: allowed.order.id,
        idempotencyKey: "wp:1",
        correlationId: "corr-wp-1",
      });
      expect(walletPurchase).toMatchObject({
        ok: false,
        code: "ORDER_NOT_PAYABLE",
        message: "Cửa hàng hiện đang tạm đóng cửa.",
      });
    }
  });
});
