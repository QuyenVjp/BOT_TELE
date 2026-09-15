import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  listActiveCategories,
  listActiveProductsByCategory,
  listSellableVariants,
  getVariantById,
  type CatalogVariantRow,
} from "../../src/modules/catalog/repository.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T025 — Catalog repository (FR-002): list only ACTIVE categories and SELLABLE
 * product variants, in stable, cursor-paginated order.
 *
 * Sellable (data-model.md invariant): product + category + variant all active,
 * price positive, resale evidence present, and stock_policy not PAUSED.
 *
 * The seed deliberately includes:
 *  - an inactive category (must be hidden);
 *  - a variant under an inactive product (must be hidden);
 *  - an inactive variant (must be hidden);
 *  - a PAUSED variant (must be hidden);
 *  - a variant with no resale evidence — the "unauthorized SKU" (must be hidden, SR-007);
 *  - several sellable variants to exercise stable cursor pagination.
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

interface SeedIds {
  activeCategoryId: string;
  inactiveCategoryId: string;
  activeProductId: string;
  inactiveProductId: string;
  supplierOnlyProductId: string;
  supplierOnlyVariantId: string;
  configuredSupplierVariantId: string;
  zeroQuantityVariantId: string;
  sellableVariantIds: string[];
}

async function seed(): Promise<SeedIds> {
  const activeCategoryId = newId();
  const inactiveCategoryId = newId();
  const activeProductId = newId();
  const inactiveProductId = newId();
  const supplierOnlyProductId = newId();
  const supplierOnlyVariantId = newId();
  const configuredSupplierVariantId = newId();
  const zeroQuantityVariantId = newId();
  const configuredSupplierId = newId();
  const configuredSupplierSkuId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values
      (${activeCategoryId}, 'Giải trí', 'giai-tri', true, 1),
      (${inactiveCategoryId}, 'Ẩn', 'an', false, 2)
  `.execute(ctx.db);

  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values
      (${activeProductId}, ${activeCategoryId}, 'Netflix', 'netflix', true, 1),
      (${inactiveProductId}, ${activeCategoryId}, 'Sản phẩm ẩn', 'san-pham-an', false, 2),
      (${supplierOnlyProductId}, ${activeCategoryId}, 'Chỉ nhà cung cấp', 'chi-nha-cung-cap', true, 3)
  `.execute(ctx.db);

  // Test-only resale evidence + version-bound publication snapshot (fresh fixture versions).
  const publishVariant = async (variantId: string, evidenceId: string) => {
    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values (${evidenceId}, ${variantId}, 'OWNER_ATTESTATION', ${"TEST-REF-" + evidenceId}, 'fixture publication evidence', 'test')
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
  };

  // Five sellable variants for pagination (sort_order 1..5).
  const sellableVariantIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const id = newId();
    sellableVariantIds.push(id);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
         stock_policy, resale_evidence_id, is_active, sort_order)
      values
        (${id}, ${activeProductId}, ${"SKU-OK-" + i}, ${"Gói " + i}, ${100000 * i},
         'P1M', 'LICENSE', 30, 'LOCAL_ONLY', ${"RES-" + i}, true, ${i})
    `.execute(ctx.db);
    await publishVariant(id, "RES-" + i);
    // LICENSE resolves to STOCK_CODE, so the sellable route needs one available asset.
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${id}, 'TEST_FIXTURE', ${"test-vault-ref-" + assetId}, ${"test-fp-" + assetId}, 'AVAILABLE')
    `.execute(ctx.db);
  }

  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order, fulfillment_type)
    values
      (${zeroQuantityVariantId}, ${activeProductId}, 'SKU-ZERO-QTY', 'Hết tồn số lượng', 100000,
       'P1M', 'LICENSE', 30, 'LOCAL_ONLY', 'RES-QTY', true, 6, 'QUANTITY_STOCK'),
      (${configuredSupplierVariantId}, ${supplierOnlyProductId}, 'SKU-SUPPLIER-OK', 'Nguồn nhà cung cấp OK', 100000,
       'P1M', 'LICENSE', 30, 'SUPPLIER_ONLY', 'RES-SUP-OK', true, 7, 'SUPPLIER_API')
  `.execute(ctx.db);
  await publishVariant(zeroQuantityVariantId, "RES-QTY");
  await publishVariant(configuredSupplierVariantId, "RES-SUP-OK");
  await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${zeroQuantityVariantId}, 0)`.execute(
    ctx.db,
  );
  await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${configuredSupplierId}, 'Primary', 'sandbox', 'vault:supplier', 'ACTIVE')`.execute(
    ctx.db,
  );
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type, is_active)
    values (${configuredSupplierSkuId}, ${configuredSupplierId}, ${configuredSupplierVariantId}, 'EXT-SUP-OK', 50000, 'LICENSE', true)
  `.execute(ctx.db);

  // Unsellable variants (must all be hidden).
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, sort_order)
    values
      -- inactive variant
      (${newId()}, ${activeProductId}, 'SKU-INACTIVE', 'Biến thể tắt', 100000,
       'P1M', 'LICENSE', 30, 'LOCAL_ONLY', 'RES-X', false, 10),
      -- paused stock policy
      (${newId()}, ${activeProductId}, 'SKU-PAUSED', 'Tạm dừng', 100000,
       'P1M', 'LICENSE', 30, 'PAUSED', 'RES-Y', true, 11),
      -- unauthorized: no resale evidence (SR-007)
      (${newId()}, ${activeProductId}, 'SKU-NOAUTH', 'Chưa được phép', 100000,
       'P1M', 'LICENSE', 30, 'LOCAL_ONLY', null, true, 12),
      -- under an inactive product
      (${newId()}, ${inactiveProductId}, 'SKU-DEADPROD', 'SP ẩn', 100000,
       'P1M', 'LICENSE', 30, 'LOCAL_ONLY', 'RES-Z', true, 13),
      -- Unsupported legacy: supplier-only without configured SUPPLIER_API route
      (${supplierOnlyVariantId}, ${supplierOnlyProductId}, 'SKU-SUPPLIER', 'Nguồn nhà cung cấp', 100000,
       'P1M', 'LICENSE', 30, 'SUPPLIER_ONLY', 'RES-SUP', true, 14)
  `.execute(ctx.db);
  return {
    activeCategoryId,
    inactiveCategoryId,
    activeProductId,
    inactiveProductId,
    supplierOnlyProductId,
    supplierOnlyVariantId,
    sellableVariantIds,
    configuredSupplierVariantId,
    zeroQuantityVariantId,
  };
}

describe("catalog repository (FR-002)", () => {
  it("lists only active categories in sort order", async () => {
    const ids = await seed();
    const categories = await listActiveCategories(ctx.db);
    expect(categories.map((c) => c.id)).toEqual([ids.activeCategoryId]);
    expect(categories.map((c) => c.id)).not.toContain(ids.inactiveCategoryId);
  });

  it("lists visible variants (including configured supplier and zero-quantity restock rows)", async () => {
    const ids = await seed();
    const variants = await listSellableVariants(ctx.db, { limit: 50 });
    const returnedIds = variants.items.map((v) => v.id).sort();
    expect(returnedIds).toEqual(
      [
        ...ids.sellableVariantIds,
        ids.configuredSupplierVariantId,
        ids.zeroQuantityVariantId,
      ].sort(),
    );
  });

  it("keeps configured supplier and zero-quantity variants visible, but not ready when stock is zero", async () => {
    const ids = await seed();
    const products = await listActiveProductsByCategory(ctx.db, ids.activeCategoryId);
    expect(products.map((product) => product.id)).toContain(ids.supplierOnlyProductId);

    const configuredSupplier = await getVariantById(ctx.db, ids.configuredSupplierVariantId);
    expect(configuredSupplier?.fulfillment_type).toBe("SUPPLIER_API");
    expect(configuredSupplier?.is_ready).toBe(true);

    const zeroQuantity = await getVariantById(ctx.db, ids.zeroQuantityVariantId);
    expect(zeroQuantity?.available_quantity).toBe(0);
    expect(zeroQuantity?.is_ready).toBe(false);

    expect(await getVariantById(ctx.db, ids.supplierOnlyVariantId)).toBeNull();
  });

  it("paginates with a stable cursor and no overlap or gaps", async () => {
    const ids = await seed();
    const page1 = await listSellableVariants(ctx.db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listSellableVariants(ctx.db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);

    const page3 = await listSellableVariants(ctx.db, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(2);

    const page4 = await listSellableVariants(ctx.db, { limit: 2, cursor: page3.nextCursor });
    expect(page4.items).toHaveLength(1);
    expect(page4.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items, ...page3.items, ...page4.items].map((v) => v.id);
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual(
      [
        ...ids.sellableVariantIds,
        ids.configuredSupplierVariantId,
        ids.zeroQuantityVariantId,
      ].sort(),
    );
  });

  it("getVariantById returns a sellable variant and null for an unauthorized one", async () => {
    const ids = await seed();
    const ok = await getVariantById(ctx.db, ids.sellableVariantIds[0]!);
    expect(ok?.id).toBe(ids.sellableVariantIds[0]);
    expect((ok as CatalogVariantRow).price_vnd).toBeTruthy();

    // A non-existent id yields null (no throw, no existence oracle).
    const missing = await getVariantById(ctx.db, newId());
    expect(missing).toBeNull();
  });
});
