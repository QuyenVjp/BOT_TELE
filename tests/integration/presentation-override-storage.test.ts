import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { getVariantById } from "../../src/modules/catalog/repository.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Variant presentation override storage: the durable source behind
 * `profileOverride` on the payment screen.
 *
 * The column is presentation-only. The database enforces just the shape it can
 * check cheaply — JSON object or null — because a non-object payload is
 * meaningless to the renderer while the real field-level rules live in the zod
 * override schema at the application edge.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table product_variant, product_alias, product, category cascade`.execute(
    ctx.db,
  );
});

/** Insert one sellable variant (active category + product + variant, price > 0, evidence set). */
async function seedSellableVariant(): Promise<string> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Giải trí', 'giai-tri', true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', 'netflix', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      (${variantId}, ${productId}, 'SKU-OVERRIDE', 'Gói 1 tháng', 100000, 'P1M', 'LICENSE', 30,
       'LOCAL_ONLY', 'RES-OVERRIDE', true, 1)
  `.execute(ctx.db);
  // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
  await sql`
    insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
    values ('RES-OVERRIDE', ${variantId}, 'OWNER_ATTESTATION', 'TEST-REF-PRESENTATION-OVERRIDE', 'fixture publication evidence', 'test')
  `.execute(ctx.db);
  await sql`
    update product_variant
       set publication_evidence_id = 'RES-OVERRIDE',
           publication_product_version = 1,
           publication_variant_version = 1,
           published_at = now(),
           published_by = 'test'
     where id = ${variantId}
  `.execute(ctx.db);
  // LICENSE resolves to STOCK_CODE: one available asset keeps the route sellable.
  const assetId = newId();
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${assetId}, ${variantId}, 'TEST_FIXTURE', ${"test-vault-ref-" + assetId}, ${"test-fp-" + assetId}, 'AVAILABLE')
  `.execute(ctx.db);
  return variantId;
}

const override = {
  headline: "Thanh toán an toàn",
  extraNotice: "Kiểm tra kỹ nội dung trước khi chuyển",
  fulfillmentNotice: null,
  showQuantity: true,
  showBankHolder: true,
  showOrderCode: true,
  showAmountCopyButton: true,
  showAccountCopyButton: true,
  showTransferContentCopyButton: true,
  showOrderCodeCopyButton: true,
  showPaymentCheckButton: true,
  showCancelButton: true,
};

describe("variant presentation override storage", () => {
  it("returns null when the variant has no override", async () => {
    const variantId = await seedSellableVariant();
    const variant = await getVariantById(ctx.db, variantId);
    expect(variant).not.toBeNull();
    expect(variant?.presentation_profile ?? null).toBeNull();
  });

  it("round-trips a stored override object through getVariantById", async () => {
    const variantId = await seedSellableVariant();
    await sql`update product_variant set presentation_profile = ${JSON.stringify(override)}::jsonb where id = ${variantId}`.execute(
      ctx.db,
    );
    const variant = await getVariantById(ctx.db, variantId);
    expect(variant?.presentation_profile).toEqual(override);
  });

  it("rejects a stored JSON value that is not an object", async () => {
    const variantId = await seedSellableVariant();
    for (const bad of ['"x"', "[]", "3", "true"]) {
      await expect(
        sql`update product_variant set presentation_profile = ${bad}::jsonb where id = ${variantId}`.execute(
          ctx.db,
        ),
      ).rejects.toThrow(/product_variant_presentation_profile_object_chk/);
    }
    const variant = await getVariantById(ctx.db, variantId);
    expect(variant?.presentation_profile ?? null).toBeNull();
  });
});
