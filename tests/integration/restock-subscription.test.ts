import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  listRestockSubscriptions,
  subscribeRestock,
  unsubscribeRestock,
} from "../../src/modules/catalog/restock.js";
import {
  presentRestockList,
  restockVariantLabel,
  subscribeRestockForCustomer,
} from "../../src/worker.js";
import { newId } from "../../src/shared/ids/index.js";
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
    truncate table restock_subscription, variant_quantity_stock, digital_asset,
      product_variant, product, category, resale_evidence, customer cascade
  `.execute(ctx.db);
});

type FulfillmentType =
  | "STOCK_ACCOUNT"
  | "STOCK_CODE"
  | "DIGITAL_FILE"
  | "SUPPLIER_API"
  | "MANUAL_FULFILLMENT"
  | "QUANTITY_STOCK"
  | "UNLIMITED_SERVICE";

type VariantOptions = {
  categoryId: string;
  name: string;
  productName?: string;
  productActive?: boolean;
  isTest?: boolean;
  isArchived?: boolean;
  variantActive?: boolean;
  publish?: boolean;
  stockPolicy?: "LOCAL_ONLY" | "SUPPLIER_ONLY" | "LOCAL_THEN_SUPPLIER";
  fulfillmentType?: FulfillmentType;
  available?: number;
  assetSource?: "LOCAL" | "GOOGLE_SHEETS" | "OWNER_IMPORT";
  preorderEnabled?: boolean;
};

async function seedCategory(slug: string, isActive = true): Promise<string> {
  const id = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${id}, ${slug}, ${slug}, ${isActive}, 1)
  `.execute(ctx.db);
  return id;
}

async function seedVariant(options: VariantOptions): Promise<string> {
  const variantId = newId();
  const productId = newId();
  const evidenceId = newId();
  const fulfillmentType = options.fulfillmentType ?? "QUANTITY_STOCK";
  const stockPolicy = options.stockPolicy ?? "LOCAL_ONLY";
  const productName = options.productName ?? `${options.name} product`;
  const shouldPublish = options.publish ?? true;

  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, is_test, is_archived, sort_order)
    values (
      ${productId}, ${options.categoryId}, ${productName}, ${"product-" + productId},
      ${options.productActive ?? true}, ${options.isTest ?? false}, ${options.isArchived ?? false}, 1
    )
  `.execute(ctx.db);
  await sql`
    insert into product_variant (
      id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
      stock_policy, fulfillment_type, resale_evidence_id, is_active, preorder_enabled
    )
    values (
      ${variantId}, ${productId}, ${"SKU-" + variantId}, ${options.name}, 100000, 'P1M',
      'CREDENTIAL', ${stockPolicy}, ${fulfillmentType}, ${evidenceId},
      ${options.variantActive ?? true}, ${options.preorderEnabled ?? false}
    )
  `.execute(ctx.db);
  await sql`
    insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
    values (${evidenceId}, ${variantId}, 'OWNER_ATTESTATION', ${"REF-" + evidenceId}, 'restock fixture', 'test')
  `.execute(ctx.db);
  if (shouldPublish) {
    await sql`
      update product_variant
      set publication_evidence_id = ${evidenceId},
          publication_product_version = 1,
          publication_variant_version = 1,
          published_at = now(),
          published_by = 'test'
      where id = ${variantId}
    `.execute(ctx.db);
  }

  if (fulfillmentType === "QUANTITY_STOCK") {
    await sql`
      insert into variant_quantity_stock (variant_id, available_quantity)
      values (${variantId}, ${options.available ?? 0})
    `.execute(ctx.db);
  } else if (
    (fulfillmentType === "STOCK_ACCOUNT" || fulfillmentType === "STOCK_CODE") &&
    (options.available ?? 0) > 0
  ) {
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${newId()}, ${variantId}, ${options.assetSource ?? "LOCAL"}, ${"fixture-vault-" + variantId}, ${newId()}, 'AVAILABLE')
    `.execute(ctx.db);
  }
  return variantId;
}

async function seedCustomer(): Promise<string> {
  const customerId = newId();
  await sql`
    insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  return customerId;
}

describe("restock subscription eligibility", () => {
  it("fails closed for stale or ineligible variants and allows a public OOS local variant to cancel", async () => {
    const publicCategoryId = await seedCategory("ai");
    const hiddenCategoryId = await seedCategory("khac");
    const customerId = await seedCustomer();

    const hiddenId = await seedVariant({
      categoryId: hiddenCategoryId,
      name: "Hidden SKU",
    });
    const testId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Test SKU",
      isTest: true,
    });
    const archivedId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Archived SKU",
      isArchived: true,
    });
    const unpublishedId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Unpublished SKU",
      publish: false,
    });
    const supplierId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Supplier SKU",
      stockPolicy: "SUPPLIER_ONLY",
      fulfillmentType: "SUPPLIER_API",
    });
    const manualId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Manual SKU",
      fulfillmentType: "MANUAL_FULFILLMENT",
    });
    const unlimitedId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Unlimited SKU",
      fulfillmentType: "UNLIMITED_SERVICE",
    });
    const readyId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Ready SKU",
      available: 1,
    });
    const nonLocalReadyId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Google Sheets Ready SKU",
      fulfillmentType: "STOCK_CODE",
      available: 1,
      assetSource: "GOOGLE_SHEETS",
    });
    const preorderId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Preorder SKU",
      preorderEnabled: true,
    });
    const validId = await seedVariant({
      categoryId: publicCategoryId,
      name: "Public OOS SKU",
    });

    const rejectedIds = [
      hiddenId,
      testId,
      archivedId,
      unpublishedId,
      supplierId,
      manualId,
      unlimitedId,
      readyId,
      nonLocalReadyId,
      preorderId,
    ];
    for (const variantId of rejectedIds) {
      await expect(subscribeRestock(ctx.db, customerId, variantId)).resolves.toBeNull();
      await expect(restockVariantLabel(ctx.db, variantId)).resolves.toBeNull();
      const reply = await subscribeRestockForCustomer(ctx.db, customerId, variantId);
      expect(reply.text).not.toContain("Đã đăng ký báo có hàng:");
    }

    const subscription = await subscribeRestock(ctx.db, customerId, validId);
    expect(subscription).toMatchObject({
      customerId,
      variantId: validId,
      active: true,
    });
    await expect(restockVariantLabel(ctx.db, validId)).resolves.toBe(
      "Public OOS SKU product — Public OOS SKU",
    );
    await expect(listRestockSubscriptions(ctx.db, customerId)).resolves.toEqual([
      expect.objectContaining({ customerId, variantId: validId, active: true }),
    ]);

    for (const variantId of [hiddenId, testId, archivedId, unpublishedId, supplierId, readyId]) {
      await sql`
        insert into restock_subscription (id, customer_id, variant_id)
        values (${newId()}, ${customerId}, ${variantId})
      `.execute(ctx.db);
    }
    const listed = await presentRestockList(ctx.db, customerId);
    expect(listed.text).toContain("Public OOS SKU product — Public OOS SKU");
    expect(listed.text).not.toMatch(
      /Hidden SKU|Test SKU|Archived SKU|Unpublished SKU|Supplier SKU|Ready SKU|Google Sheets Ready SKU/,
    );
    expect(listed.buttons.flat().map((button) => button.callbackData)).toContain(
      `rst:unsub:${validId}`,
    );

    await expect(unsubscribeRestock(ctx.db, customerId, validId)).resolves.toBe(true);
    await expect(unsubscribeRestock(ctx.db, customerId, validId)).resolves.toBe(false);
    await expect(listRestockSubscriptions(ctx.db, customerId)).resolves.not.toContainEqual(
      expect.objectContaining({ variantId: validId }),
    );

    const empty = await presentRestockList(ctx.db, customerId);
    expect(empty.text).toContain("chưa theo dõi");
    expect(empty.buttons.flat().map((button) => button.callbackData)).toEqual([
      "shop:home",
      "supp:open",
    ]);
  });
  it("keeps concurrent duplicate subscriptions to one public OOS row", async () => {
    const categoryId = await seedCategory("ai");
    const customerId = await seedCustomer();
    const variantId = await seedVariant({ categoryId, name: "Concurrent OOS SKU" });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => subscribeRestock(ctx.db, customerId, variantId)),
    );

    expect(results.every((result) => result?.active)).toBe(true);
    const rows = await sql<{ count: string }>`
      select count(*)::text as count
      from restock_subscription
      where customer_id = ${customerId} and variant_id = ${variantId}
    `.execute(ctx.db);
    expect(rows.rows[0]?.count).toBe("1");
  });
});
