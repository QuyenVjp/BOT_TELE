import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import type { NormalizedSupplierProduct } from "../../src/modules/supplier/port.js";
import {
  configureSupplierCatalogProduct,
  ensureSupplierProvider,
  getSupplierCatalogProduct,
  listSupplierCatalog,
  setSupplierCatalogEnabled,
  setSupplierCatalogPrimary,
  syncSupplierCatalog,
} from "../../src/modules/supplier/catalog.js";
import { listSellableVariants } from "../../src/modules/catalog/repository.js";
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
    truncate table supplier_catalog_product, supplier_order, supplier_sku, supplier,
      product_variant, product, category, audit_event cascade
  `.execute(ctx.db);
});

function product(overrides: Partial<NormalizedSupplierProduct> = {}): NormalizedSupplierProduct {
  return {
    providerKey: "qcst",
    externalProductId: "qcst-product-1",
    externalVariantId: null,
    nameVi: "Upstream product",
    nameEn: "Upstream product",
    descriptionVi: "Upstream description",
    descriptionEn: "Upstream description",
    warrantyVi: "30 days",
    warrantyEn: "30 days",
    customerInputType: "NONE",
    requiresCustomerInput: false,
    customerInputsPerItem: 0,
    customerPromptVi: "",
    customerPromptEn: "",
    fulfillmentMode: "AUTOMATIC",
    availability: "AVAILABLE",
    stockType: "FINITE",
    stockQuantity: 2,
    minQuantity: 1,
    maxQuantity: 1,
    fixedQuantity: 1,
    costVnd: 100_000,
    pricingSource: "BASE",
    currency: "VND",
    upstreamUpdatedAt: "2026-09-24T00:00:00Z",
    supportStatus: "SUPPORTED",
    unsupportedReason: null,
    metadataSafe: {},
    ...overrides,
  };
}

async function ensure(providerKey: string, displayName = providerKey): Promise<void> {
  await ensureSupplierProvider(ctx.db, {
    providerKey,
    displayName,
    adapterType: providerKey.toUpperCase(),
    credentialVaultRef: `vault:${providerKey}-api-key`,
    baseUrl: `https://${providerKey}.example.invalid/api`,
    capabilities: ["CATALOG_LIST"],
  });
}

describe("generic supplier curation persistence", () => {
  it("keeps upstream sync separate from owner selection and preserves missing history", async () => {
    await ensure("qcst", "QCST");
    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [
        product(),
        product({ externalProductId: "qcst-product-2", availability: "OUT", stockQuantity: 0 }),
      ],
      "supplier-sync-1",
    );

    const discovered = await listSupplierCatalog(ctx.db, {
      supplierId: "qcst",
      limit: 8,
      offset: 0,
    });
    expect(discovered.items).toHaveLength(2);
    expect(
      discovered.items.every((row) => row.selection_status === "DISCOVERED" && !row.is_enabled),
    ).toBe(true);

    const configured = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.items[0]!.id,
      localNameVi: "Tên local",
      localVariantNameVi: "Gói local",
      localPriceVnd: 199_000n,
      localDescriptionVi: "Mô tả local",
      enabled: true,
      expectedVersion: discovered.items[0]!.version,
      actorId: "123456789",
      correlationId: "supplier-config-1",
    });
    expect(configured.enabled).toBe(true);

    const selected = await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.items[0]!.id,
    });
    expect(selected).toMatchObject({
      selection_status: "SELECTED",
      is_enabled: true,
      local_name_vi: "Tên local",
      local_variant_name_vi: "Gói local",
    });

    await expect(
      configureSupplierCatalogProduct(ctx.db, {
        supplierId: "qcst",
        catalogId: discovered.items[0]!.id,
        localNameVi: "Tên local mới",
        localVariantNameVi: "Gói local mới",
        localPriceVnd: 299_000n,
        localDescriptionVi: "Không được ghi đè",
        enabled: true,
        expectedVersion: discovered.items[0]!.version,
        actorId: "123456789",
        correlationId: "supplier-stale-config",
      }),
    ).rejects.toThrow("SUPPLIER_STALE_VERSION");
    expect(
      await getSupplierCatalogProduct(ctx.db, {
        supplierId: "qcst",
        catalogId: discovered.items[0]!.id,
      }),
    ).toMatchObject({
      local_name_vi: "Tên local",
      local_variant_name_vi: "Gói local",
    });

    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [product({ availability: "LOW" })],
      "supplier-sync-2",
    );
    const missing = await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.items[1]!.id,
    });
    expect(missing).toMatchObject({
      availability: "MISSING",
      is_missing: true,
      is_enabled: false,
      selection_status: "DISCOVERED",
    });

    await expect(
      setSupplierCatalogEnabled(ctx.db, {
        supplierId: "qcst",
        catalogId: discovered.items[1]!.id,
        enabled: true,
        expectedVersion: missing!.version,
        actorId: "123456789",
        correlationId: "supplier-enable-1",
      }),
    ).rejects.toThrow("SUPPLIER_PRODUCT_UNAVAILABLE");

    await expect(
      syncSupplierCatalog(
        ctx.db,
        "qcst",
        [product(), product({ externalProductId: "qcst-product-1" })],
        "supplier-sync-duplicate",
      ),
    ).rejects.toThrow("SUPPLIER_DUPLICATE_EXTERNAL_PRODUCT");
  });

  it("preserves an existing mapping when an upstream product becomes unsupported", async () => {
    await ensure("qcst", "QCST");
    await syncSupplierCatalog(ctx.db, "qcst", [product()], "supplier-unsupported-before");
    const discovered = (
      await listSupplierCatalog(ctx.db, { supplierId: "qcst", limit: 8, offset: 0 })
    ).items[0]!;
    const configured = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.id,
      localNameVi: "Tên local",
      localVariantNameVi: "Gói local",
      localPriceVnd: 199_000n,
      localDescriptionVi: "Mô tả local",
      enabled: true,
      expectedVersion: discovered.version,
      actorId: "123456789",
      correlationId: "supplier-unsupported-configure",
    });

    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [
        product({
          maxQuantity: 0,
          supportStatus: "UNSUPPORTED",
          unsupportedReason: "MAX_QUANTITY_SEMANTICS_UNKNOWN",
        }),
      ],
      "supplier-unsupported-after",
    );

    const current = (await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.id,
    }))!;
    expect(current).toMatchObject({
      domain_status: "UNSUPPORTED",
      domain_unsupported_reason: "MAX_QUANTITY_SEMANTICS_UNKNOWN",
      is_missing: false,
      is_enabled: false,
      selection_status: "SELECTED",
      local_variant_id: configured.variantId,
    });
    await expect(
      setSupplierCatalogEnabled(ctx.db, {
        supplierId: "qcst",
        catalogId: discovered.id,
        enabled: true,
        expectedVersion: current.version,
        actorId: "123456789",
        correlationId: "supplier-unsupported-enable",
      }),
    ).rejects.toThrow("SUPPLIER_PRODUCT_UNSUPPORTED");
  });

  it("aborts invalid normalized input before marking existing mappings missing", async () => {
    await ensure("qcst", "QCST");
    await syncSupplierCatalog(ctx.db, "qcst", [product()], "supplier-invalid-before");

    await expect(
      syncSupplierCatalog(
        ctx.db,
        "qcst",
        [product({ externalProductId: "qcst-invalid", customerInputsPerItem: -1 })],
        "supplier-invalid-after",
      ),
    ).rejects.toThrow("SUPPLIER_PRODUCT_INVALID");

    const current = (await listSupplierCatalog(ctx.db, { supplierId: "qcst", limit: 8, offset: 0 }))
      .items[0]!;
    expect(current).toMatchObject({ external_product_id: "qcst-product-1", is_missing: false });
  });

  it("keeps local selling price stable when supplier cost changes", async () => {
    await ensure("qcst", "QCST");
    await syncSupplierCatalog(ctx.db, "qcst", [product({ costVnd: 50_000 })], "supplier-cost-1");
    const initial = (await listSupplierCatalog(ctx.db, { supplierId: "qcst", limit: 8, offset: 0 }))
      .items[0]!;

    const configured = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: initial.id,
      localNameVi: "Tên local",
      localVariantNameVi: "Gói local",
      localPriceVnd: 79_000n,
      localDescriptionVi: "Giá local độc lập",
      enabled: true,
      expectedVersion: initial.version,
      actorId: "123456789",
      correlationId: "supplier-cost-config",
    });
    const before = await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: initial.id,
    });
    expect(before?.supplier_cost_vnd).toBe("50000");
    const beforePrice = await sql<{ price_vnd: string }>`
      select price_vnd::text from product_variant where id = ${configured.variantId}
    `.execute(ctx.db);
    expect(beforePrice.rows[0]?.price_vnd).toBe("79000");

    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [product({ costVnd: 65_000, availability: "LOW" })],
      "supplier-cost-2",
    );
    const after = await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: initial.id,
    });
    expect(after).toMatchObject({
      supplier_cost_vnd: "65000",
      local_product_id: configured.productId,
      local_variant_id: configured.variantId,
    });
    const afterPrice = await sql<{ price_vnd: string }>`
      select price_vnd::text from product_variant where id = ${configured.variantId}
    `.execute(ctx.db);
    expect(afterPrice.rows[0]?.price_vnd).toBe("79000");
  });

  it("keeps existing SKU fields stable across QCST and Vô Không attachments", async () => {
    await ensure("qcst", "QCST");
    await ensure("vokhong", "Vô Không");
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${categoryId}, 'Category', ${categoryId.slice(-8)}, true, 1)
    `.execute(ctx.db);
    await sql`
      insert into product
        (id, category_id, name_vi, short_description_vi, description_vi, slug, is_active, is_archived, sort_order)
      values
        (${productId}, ${categoryId}, 'A', 'C', 'C', ${productId.slice(-8)}, true, false, 1)
    `.execute(ctx.db);
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
         stock_policy, fulfillment_type, is_active)
      values
        (${variantId}, ${productId}, 'SKU-A', 'B', 159000, 'CUSTOM', 'CREDENTIAL',
         'SUPPLIER_ONLY', 'SUPPLIER_API', true)
    `.execute(ctx.db);

    await syncSupplierCatalog(ctx.db, "qcst", [product()], "supplier-multi-qcst");
    const qcstRow = (await listSupplierCatalog(ctx.db, { supplierId: "qcst", limit: 8, offset: 0 }))
      .items[0]!;
    const qcstAttached = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: qcstRow.id,
      targetVariantId: variantId,
      makePrimary: true,
      localNameVi: "supplier overwrite A",
      localVariantNameVi: "supplier overwrite B",
      localPriceVnd: 1n,
      localDescriptionVi: "supplier overwrite C",
      enabled: true,
      expectedVersion: qcstRow.version,
      actorId: "123456789",
      correlationId: "supplier-multi-qcst-attach",
    });
    expect(qcstAttached).toMatchObject({ variantId, primary: true });

    await syncSupplierCatalog(
      ctx.db,
      "vokhong",
      [product({ providerKey: "vokhong", costVnd: 80_000 })],
      "supplier-multi-vokhong",
    );
    const vokhongRow = (
      await listSupplierCatalog(ctx.db, { supplierId: "vokhong", limit: 8, offset: 0 })
    ).items[0]!;
    const vokhongAttached = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "vokhong",
      catalogId: vokhongRow.id,
      targetVariantId: variantId,
      makePrimary: false,
      localNameVi: "another overwrite A",
      localVariantNameVi: "another overwrite B",
      localPriceVnd: 2n,
      localDescriptionVi: "another overwrite C",
      enabled: true,
      expectedVersion: vokhongRow.version,
      actorId: "123456789",
      correlationId: "supplier-multi-vokhong-attach",
    });
    expect(vokhongAttached).toMatchObject({ variantId, primary: false });

    const local = await sql<{
      product_name_vi: string;
      short_description_vi: string | null;
      product_description_vi: string | null;
      variant_name_vi: string;
      price_vnd: string;
      primary_supplier_id: string | null;
    }>`
      select p.name_vi as product_name_vi, p.short_description_vi,
             p.description_vi as product_description_vi, v.name_vi as variant_name_vi,
             v.price_vnd::text as price_vnd, ss.supplier_id as primary_supplier_id
      from product p
      join product_variant v on v.product_id = p.id
      left join supplier_sku ss on ss.id = v.supplier_sku_id
      where v.id = ${variantId}
    `.execute(ctx.db);
    expect(local.rows[0]).toMatchObject({
      product_name_vi: "A",
      short_description_vi: "C",
      product_description_vi: "C",
      variant_name_vi: "B",
      price_vnd: "159000",
      primary_supplier_id: "qcst",
    });

    const mappings = await sql<{ count: number }>`
      select count(*)::int as count from supplier_sku where variant_id = ${variantId}
    `.execute(ctx.db);
    expect(mappings.rows[0]?.count).toBe(2);

    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [product({ availability: "OUT", stockQuantity: 0 })],
      "supplier-multi-qcst-out",
    );
    const beforeExplicitSwitch = await sql<{ supplier_id: string }>`
      select ss.supplier_id
      from product_variant v
      join supplier_sku ss on ss.id = v.supplier_sku_id
      where v.id = ${variantId}
    `.execute(ctx.db);
    expect(beforeExplicitSwitch.rows[0]?.supplier_id).toBe("qcst");
    const primary = await setSupplierCatalogPrimary(ctx.db, {
      supplierId: "vokhong",
      catalogId: vokhongRow.id,
      expectedVersion: (await getSupplierCatalogProduct(ctx.db, {
        supplierId: "vokhong",
        catalogId: vokhongRow.id,
      }))!.version,
      actorId: "123456789",
      correlationId: "supplier-multi-primary",
    });
    expect(primary.variantId).toBe(variantId);
    const pointer = await sql<{ supplier_id: string }>`
      select ss.supplier_id from product_variant v
      join supplier_sku ss on ss.id = v.supplier_sku_id
      where v.id = ${variantId}
    `.execute(ctx.db);
    expect(pointer.rows[0]?.supplier_id).toBe("vokhong");
  });

  it("keeps unselected and missing mappings out while out-of-stock is not ready", async () => {
    await ensure("qcst", "QCST");
    await syncSupplierCatalog(ctx.db, "qcst", [product()], "supplier-route-1");
    const discovered = (
      await listSupplierCatalog(ctx.db, { supplierId: "qcst", limit: 8, offset: 0 })
    ).items[0]!;
    const configured = await configureSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.id,
      localNameVi: "Route local",
      localVariantNameVi: "Gói route",
      localPriceVnd: 99_000n,
      localDescriptionVi: "Route test",
      enabled: false,
      expectedVersion: discovered.version,
      actorId: "123456789",
      correlationId: "supplier-route-config",
    });

    await sql`
      insert into resale_evidence (id, variant_id, source, reference, summary, created_by)
      values (
        'QCST-ROUTE-EVIDENCE',
        ${configured.variantId},
        'OWNER_ATTESTATION',
        'QCST-ROUTE-TEST',
        'fixture publication evidence',
        'test'
      )
    `.execute(ctx.db);
    await sql`
      update product_variant
         set resale_evidence_id = 'QCST-ROUTE-EVIDENCE',
             publication_evidence_id = 'QCST-ROUTE-EVIDENCE',
             publication_product_version = 1,
             publication_variant_version = version,
             published_at = now()
       where id = ${configured.variantId}
    `.execute(ctx.db);

    await expect(
      listSellableVariants(ctx.db, {
        limit: 8,
        productId: configured.productId,
        audience: "test",
      }),
    ).resolves.toMatchObject({ items: [] });

    const selected = (await getSupplierCatalogProduct(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.id,
    }))!;
    await setSupplierCatalogEnabled(ctx.db, {
      supplierId: "qcst",
      catalogId: discovered.id,
      enabled: true,
      expectedVersion: selected.version,
      actorId: "123456789",
      correlationId: "supplier-route-enable",
    });
    await expect(
      listSellableVariants(ctx.db, {
        limit: 8,
        productId: configured.productId,
        audience: "test",
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: configured.variantId, is_ready: true })],
    });

    await syncSupplierCatalog(
      ctx.db,
      "qcst",
      [product({ availability: "OUT", stockQuantity: 0 })],
      "supplier-route-2",
    );
    const outOfStock = await listSellableVariants(ctx.db, {
      limit: 8,
      productId: configured.productId,
      audience: "test",
    });
    expect(outOfStock.items).toHaveLength(1);
    expect(outOfStock.items[0]?.is_ready).toBe(false);

    await syncSupplierCatalog(ctx.db, "qcst", [], "supplier-route-3");
    await expect(
      listSellableVariants(ctx.db, {
        limit: 8,
        productId: configured.productId,
        audience: "test",
      }),
    ).resolves.toMatchObject({ items: [] });
  });
});
