import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import { getOrCreateUncategorizedCategory } from "../catalog/repository.js";
import { newId } from "../../shared/ids/index.js";
import type { NormalizedSupplierProduct } from "./port.js";

export type SupplierAvailability = "AVAILABLE" | "LOW" | "OUT" | "UNKNOWN" | "MISSING";
export type SupplierSelectionStatus = "DISCOVERED" | "SELECTED";

export interface SupplierCatalogRow {
  id: string;
  supplier_id: string;
  external_product_id: string;
  external_variant_id: string;
  upstream_name_vi: string;
  upstream_description_vi: string | null;
  availability: SupplierAvailability;
  stock_quantity: number | null;
  supplier_cost_vnd: string;
  currency: string;
  selection_status: SupplierSelectionStatus;
  is_enabled: boolean;
  is_missing: boolean;
  local_product_id: string | null;
  local_variant_id: string | null;
  supplier_sku_id: string | null;
  local_name_vi: string | null;
  local_variant_name_vi: string | null;
  local_description_vi: string | null;
  is_primary: boolean;
  updated_at: string;
  version: number;
}

export interface SupplierCatalogPage {
  items: SupplierCatalogRow[];
  nextOffset: number | null;
  total: number;
}

export interface SupplierCurationInput {
  supplierId: string;
  catalogId: string;
  localNameVi: string;
  localVariantNameVi: string;
  localPriceVnd: bigint;
  localDescriptionVi: string;
  enabled: boolean;
  expectedVersion: number;
  targetVariantId?: string | null;
  makePrimary?: boolean;
  actorId: string;
  correlationId: string;
}

export interface SupplierCurationText {
  localNameVi: string;
  localVariantNameVi: string;
  localPriceVnd: bigint;
  localDescriptionVi: string;
}

export interface SupplierLocalVariantTarget {
  variantId: string;
  productId: string;
  productNameVi: string;
  descriptionVi: string | null;
  variantNameVi: string;
  sku: string;
  priceVnd: string;
  primarySupplierId: string | null;
}

function normalizeAvailability(value: string): SupplierAvailability {
  const normalized = value.trim().toUpperCase();
  if (normalized === "AVAILABLE") return "AVAILABLE";
  if (normalized === "LOW") return "LOW";
  if (normalized === "OUT" || normalized === "OUT_OF_STOCK" || normalized === "UNAVAILABLE") {
    return "OUT";
  }
  return "UNKNOWN";
}

function validateCurationInput(input: SupplierCurationInput, requireLocalFields = true): void {
  if (!input.supplierId.trim() || !input.catalogId.trim()) {
    throw new Error("SUPPLIER_CATALOG_NOT_FOUND");
  }
  if (requireLocalFields) {
    if (!input.localNameVi.trim() || input.localNameVi.length > 200) {
      throw new Error("SUPPLIER_LOCAL_NAME_INVALID");
    }
    if (!input.localVariantNameVi.trim() || input.localVariantNameVi.length > 200) {
      throw new Error("SUPPLIER_LOCAL_VARIANT_NAME_INVALID");
    }
    if (input.localPriceVnd <= 0n || input.localPriceVnd > 1_000_000_000_000n) {
      throw new Error("SUPPLIER_LOCAL_PRICE_INVALID");
    }
    if (input.localDescriptionVi.length > 2_000) {
      throw new Error("SUPPLIER_LOCAL_DESCRIPTION_INVALID");
    }
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("SUPPLIER_VERSION_INVALID");
  }
  if (!input.actorId.trim() || !input.correlationId.trim()) {
    throw new Error("SUPPLIER_AUDIT_CONTEXT_INVALID");
  }
}

export function parseSupplierCurationText(text: string): SupplierCurationText {
  const fields = text.split("|").map((field) => field.trim());
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
    throw new Error("SUPPLIER_FORMAT_INVALID");
  }
  let price: bigint;
  try {
    price = BigInt(fields[2]!);
  } catch {
    throw new Error("SUPPLIER_LOCAL_PRICE_INVALID");
  }
  const result = {
    localNameVi: fields[0]!,
    localVariantNameVi: fields[1]!,
    localPriceVnd: price,
    localDescriptionVi: fields[3]!,
  };
  validateCurationInput({
    supplierId: "preview",
    catalogId: "preview",
    ...result,
    enabled: false,
    expectedVersion: 1,
    actorId: "preview",
    correlationId: "preview",
  });
  return result;
}

export async function ensureSupplierProvider(
  db: Db,
  input: {
    providerKey: string;
    displayName: string;
    adapterType: string;
    credentialVaultRef: string;
    baseUrl: string;
    capabilities: readonly string[];
  },
): Promise<void> {
  if (!input.providerKey.trim() || !input.credentialVaultRef.startsWith("vault:")) {
    throw new Error("SUPPLIER_VAULT_REF_INVALID");
  }
  await sql`
    insert into supplier
      (id, name, adapter_type, credential_vault_ref, status, timeout_policy,
       base_url, provider_capabilities, updated_at)
    values
      (${input.providerKey}, ${input.displayName}, ${input.adapterType}, ${input.credentialVaultRef},
       'ACTIVE', '{"autoFailover":false}'::jsonb, ${input.baseUrl},
       ${JSON.stringify(input.capabilities)}::jsonb, now())
    on conflict (id) do update
      set name = excluded.name,
          adapter_type = excluded.adapter_type,
          credential_vault_ref = excluded.credential_vault_ref,
          base_url = excluded.base_url,
          provider_capabilities = excluded.provider_capabilities,
          status = 'ACTIVE',
          updated_at = now(),
          version = supplier.version + 1
  `.execute(db);
}

export async function syncSupplierCatalog(
  db: Db,
  supplierId: string,
  products: readonly NormalizedSupplierProduct[],
  correlationId: string,
): Promise<{ discovered: number; updated: number; missing: number }> {
  const keys = new Set<string>();
  const identityPairs: Array<readonly [string, string]> = [];
  for (const product of products) {
    if (product.providerKey !== supplierId) throw new Error("SUPPLIER_PROVIDER_MISMATCH");
    const externalVariantId = product.externalVariantId ?? "";
    const key = JSON.stringify([product.externalProductId, externalVariantId]);
    if (keys.has(key)) throw new Error("SUPPLIER_DUPLICATE_EXTERNAL_PRODUCT");
    keys.add(key);
    identityPairs.push([product.externalProductId, externalVariantId]);
  }

  return withTransaction(db, async (trx) => {
    let discovered = 0;
    for (const product of products) {
      const externalVariantId = product.externalVariantId ?? "";
      const result = await sql<{ id: string; inserted: boolean }>`
        insert into supplier_catalog_product
          (id, supplier_id, external_product_id, external_variant_id,
           upstream_name_vi, upstream_name_en, upstream_description_vi,
           upstream_description_en, upstream_warranty_vi, upstream_warranty_en,
           customer_input_type, requires_customer_input, customer_inputs_per_item,
           customer_prompt_vi, customer_prompt_en, fulfillment_mode, availability,
           stock_type, stock_quantity, min_quantity, max_quantity, fixed_quantity,
           supplier_cost_vnd, currency, pricing_source, upstream_updated_at,
           selection_status, is_enabled, is_missing, last_synced_at, updated_at)
        values
          (${newId()}, ${supplierId}, ${product.externalProductId}, ${externalVariantId},
           ${product.nameVi}, ${product.nameEn}, ${product.descriptionVi},
           ${product.descriptionEn}, ${product.warrantyVi}, ${product.warrantyEn},
           ${product.customerInputType}, ${product.requiresCustomerInput},
           ${product.customerInputsPerItem}, ${product.customerPromptVi},
           ${product.customerPromptEn}, ${product.fulfillmentMode},
           ${normalizeAvailability(product.availability)}, ${product.stockType},
           ${product.stockQuantity}, ${product.minQuantity}, ${product.maxQuantity},
           ${product.fixedQuantity}, ${product.costVnd}, ${product.currency},
           ${product.pricingSource}, ${product.upstreamUpdatedAt}, 'DISCOVERED',
           false, false, now(), now())
        on conflict (supplier_id, external_product_id, external_variant_id) do update set
          upstream_name_vi = excluded.upstream_name_vi,
          upstream_name_en = excluded.upstream_name_en,
          upstream_description_vi = excluded.upstream_description_vi,
          upstream_description_en = excluded.upstream_description_en,
          upstream_warranty_vi = excluded.upstream_warranty_vi,
          upstream_warranty_en = excluded.upstream_warranty_en,
          customer_input_type = excluded.customer_input_type,
          requires_customer_input = excluded.requires_customer_input,
          customer_inputs_per_item = excluded.customer_inputs_per_item,
          customer_prompt_vi = excluded.customer_prompt_vi,
          customer_prompt_en = excluded.customer_prompt_en,
          fulfillment_mode = excluded.fulfillment_mode,
          availability = excluded.availability,
          stock_type = excluded.stock_type,
          stock_quantity = excluded.stock_quantity,
          min_quantity = excluded.min_quantity,
          max_quantity = excluded.max_quantity,
          fixed_quantity = excluded.fixed_quantity,
          supplier_cost_vnd = excluded.supplier_cost_vnd,
          currency = excluded.currency,
          pricing_source = excluded.pricing_source,
          upstream_updated_at = excluded.upstream_updated_at,
          is_missing = false,
          last_synced_at = now(),
          updated_at = now(),
          version = supplier_catalog_product.version + 1
        returning id, (xmax = 0) as inserted
      `.execute(trx);
      if (result.rows[0]?.inserted) discovered += 1;
    }

    const missing = products.length
      ? await sql<{ count: number }>`
          with changed as (
            update supplier_catalog_product
            set availability = 'MISSING', is_missing = true, is_enabled = false,
                updated_at = now(), version = version + 1
            where supplier_id = ${supplierId}
              and (external_product_id, external_variant_id) not in (${sql.join(
                identityPairs.map(
                  ([externalProductId, externalVariantId]) =>
                    sql`(${externalProductId}, ${externalVariantId})`,
                ),
                sql`, `,
              )})
            returning id
          )
          select count(*)::int as count from changed
        `.execute(trx)
      : await sql<{ count: number }>`
          with changed as (
            update supplier_catalog_product
            set availability = 'MISSING', is_missing = true, is_enabled = false,
                updated_at = now(), version = version + 1
            where supplier_id = ${supplierId}
            returning id
          )
          select count(*)::int as count from changed
        `.execute(trx);

    await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      action: "supplier.catalog.sync",
      targetType: "Supplier",
      targetId: supplierId,
      reason: "Supplier catalog read-only sync",
      correlationId,
      metadataRedacted: {
        received: products.length,
        discovered,
        missing: missing.rows[0]?.count ?? 0,
      },
    });
    return {
      discovered,
      updated: products.length - discovered,
      missing: missing.rows[0]?.count ?? 0,
    };
  });
}

function catalogProjection(): string {
  return `
    cp.id, cp.supplier_id, cp.external_product_id, cp.external_variant_id,
    cp.upstream_name_vi, cp.upstream_description_vi, cp.availability,
    cp.stock_quantity, cp.supplier_cost_vnd, cp.currency, cp.selection_status,
    cp.is_enabled, cp.is_missing, cp.local_product_id, cp.local_variant_id,
    cp.supplier_sku_id, cp.local_name_vi, cp.local_variant_name_vi,
    cp.local_description_vi, cp.updated_at, cp.version,
    coalesce(pv.supplier_sku_id = cp.supplier_sku_id, false) as is_primary
  `;
}

export async function listSupplierCatalog(
  exec: Executor,
  input: {
    supplierId: string;
    limit?: number;
    offset?: number;
    selectionStatus?: SupplierSelectionStatus;
  },
): Promise<SupplierCatalogPage> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const offset = Math.max(0, Math.min(input.offset ?? 0, 10_000));
  const status = input.selectionStatus
    ? sql`and cp.selection_status = ${input.selectionStatus}`
    : sql``;
  const result = await sql<SupplierCatalogRow & { total_count: number }>`
    select ${sql.raw(catalogProjection())}, count(*) over()::int as total_count
    from supplier_catalog_product cp
    left join product_variant pv on pv.id = cp.local_variant_id
    where cp.supplier_id = ${input.supplierId} ${status}
    order by cp.external_product_id asc, cp.external_variant_id asc, cp.id asc
    limit ${limit + 1} offset ${offset}
  `.execute(exec);
  const hasMore = result.rows.length > limit;
  const items = hasMore ? result.rows.slice(0, limit) : result.rows;
  return {
    items,
    nextOffset: hasMore ? offset + limit : null,
    total: result.rows[0]?.total_count ?? 0,
  };
}

export async function getSupplierCatalogProduct(
  exec: Executor,
  input: { supplierId: string; catalogId: string },
): Promise<SupplierCatalogRow | null> {
  const result = await sql<SupplierCatalogRow>`
    select ${sql.raw(catalogProjection())}
    from supplier_catalog_product cp
    left join product_variant pv on pv.id = cp.local_variant_id
    where cp.id = ${input.catalogId} and cp.supplier_id = ${input.supplierId}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

export async function listSupplierLocalVariantTargets(
  exec: Executor,
  input: { limit?: number; offset?: number },
): Promise<{ items: SupplierLocalVariantTarget[]; nextOffset: number | null }> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const offset = Math.max(0, Math.min(input.offset ?? 0, 10_000));
  const result = await sql<SupplierLocalVariantTarget>`
    select v.id as "variantId", p.id as "productId", p.name_vi as "productNameVi",
           p.description_vi as "descriptionVi", v.name_vi as "variantNameVi",
           v.sku, v.price_vnd::text as "priceVnd", s.id as "primarySupplierId"
    from product_variant v
    join product p on p.id = v.product_id
    left join supplier_sku ss on ss.id = v.supplier_sku_id
    left join supplier s on s.id = ss.supplier_id
    where p.is_active and not p.is_archived and v.is_active
    order by p.name_vi asc, v.sort_order asc, v.id asc
    limit ${limit + 1} offset ${offset}
  `.execute(exec);
  const hasMore = result.rows.length > limit;
  return {
    items: hasMore ? result.rows.slice(0, limit) : result.rows,
    nextOffset: hasMore ? offset + limit : null,
  };
}
export async function getSupplierLocalVariantTarget(
  exec: Executor,
  variantId: string,
): Promise<SupplierLocalVariantTarget | null> {
  const result = await sql<SupplierLocalVariantTarget>`
    select v.id as "variantId", v.product_id as "productId", p.name_vi as "productNameVi",
           p.description_vi as "descriptionVi", v.name_vi as "variantNameVi",
           v.sku, v.price_vnd::text as "priceVnd", s.id as "primarySupplierId"
    from product_variant v
    join product p on p.id = v.product_id
    left join supplier_sku ss on ss.id = v.supplier_sku_id
    left join supplier s on s.id = ss.supplier_id
    where v.id = ${variantId} and p.is_active and not p.is_archived and v.is_active
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

function slugPart(value: string): string {
  const cleaned = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 70) || "product";
}

function externalSku(row: { external_product_id: string; external_variant_id: string }): string {
  const product = row.external_product_id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  const variant = row.external_variant_id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 30);
  return `SUP-${product}${variant ? `-${variant}` : ""}-${newId().slice(-8).toLowerCase()}`.slice(
    0,
    128,
  );
}

export async function configureSupplierCatalogProduct(
  db: Db,
  input: SupplierCurationInput,
): Promise<{
  enabled: boolean;
  productId: string;
  variantId: string;
  supplierSkuId: string;
  primary: boolean;
}> {
  validateCurationInput(input, !input.targetVariantId);
  return withTransaction(db, async (trx) => {
    const locked = await sql<{
      id: string;
      version: number;
      supplier_id: string;
      external_product_id: string;
      external_variant_id: string;
      upstream_name_vi: string;
      availability: SupplierAvailability;
      is_missing: boolean;
      local_product_id: string | null;
      local_variant_id: string | null;
      supplier_sku_id: string | null;
      supplier_cost_vnd: string;
    }>`
      select id, version, supplier_id, external_product_id, external_variant_id,
             upstream_name_vi, availability, is_missing, local_product_id,
             local_variant_id, supplier_sku_id, supplier_cost_vnd
      from supplier_catalog_product
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
      for update
    `.execute(trx);
    const row = locked.rows[0];
    if (!row) throw new Error("SUPPLIER_CATALOG_NOT_FOUND");
    if (row.version !== input.expectedVersion) throw new Error("SUPPLIER_STALE_VERSION");

    let productId = row.local_product_id;
    let variantId = row.local_variant_id;
    let localNameVi = input.localNameVi;
    let localVariantNameVi = input.localVariantNameVi;
    let localPriceVnd = input.localPriceVnd;
    let localDescriptionVi = input.localDescriptionVi;
    const requestedVariantId = input.targetVariantId ?? row.local_variant_id;

    if (requestedVariantId) {
      if (
        input.targetVariantId &&
        row.local_variant_id &&
        row.local_variant_id !== input.targetVariantId
      ) {
        throw new Error("SUPPLIER_TARGET_VARIANT_CONFLICT");
      }
      const target = await sql<{
        product_id: string;
        product_name_vi: string;
        product_description_vi: string | null;
        variant_name_vi: string;
        price_vnd: string;
        fulfillment_type: string;
        stock_policy: string;
      }>`
        select v.product_id, p.name_vi as product_name_vi,
               p.description_vi as product_description_vi, v.name_vi as variant_name_vi,
               v.price_vnd::text as price_vnd, v.fulfillment_type, v.stock_policy
        from product_variant v
        join product p on p.id = v.product_id
        where v.id = ${requestedVariantId} and v.is_active and p.is_active and not p.is_archived
        limit 1
      `.execute(trx);
      const targetRow = target.rows[0];
      if (!targetRow) throw new Error("SUPPLIER_TARGET_VARIANT_NOT_FOUND");
      if (
        targetRow.fulfillment_type !== "SUPPLIER_API" ||
        targetRow.stock_policy !== "SUPPLIER_ONLY"
      ) {
        throw new Error("SUPPLIER_TARGET_VARIANT_INCOMPATIBLE");
      }
      productId = targetRow.product_id;
      variantId = requestedVariantId;
      localNameVi = targetRow.product_name_vi;
      localVariantNameVi = targetRow.variant_name_vi;
      localPriceVnd = BigInt(targetRow.price_vnd);
      localDescriptionVi = targetRow.product_description_vi ?? "";
    }

    if (!variantId) {
      if (productId) throw new Error("SUPPLIER_TARGET_VARIANT_NOT_FOUND");
      const category = await getOrCreateUncategorizedCategory(trx);
      productId = newId();
      variantId = newId();
      const suffix = newId().slice(-8).toLowerCase();
      await sql`
        insert into product
          (id, category_id, name_vi, slug, short_description_vi, description_vi,
           is_test, is_active, is_archived, is_featured, featured_rank, stock_display_mode)
        values
          (${productId}, ${category.id}, ${localNameVi.trim()},
           ${`supplier-${slugPart(row.external_product_id)}-${suffix}`.slice(0, 128)},
           ${localDescriptionVi.trim() || null}, ${localDescriptionVi.trim() || null},
           false, true, false, false, null, 'BAND')
      `.execute(trx);
      await sql`
        insert into product_variant
          (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
           warranty_days, stock_policy, fulfillment_type, inventory_fields,
           low_stock_threshold, preorder_enabled, is_active, warranty_enabled)
        values
          (${variantId}, ${productId}, ${externalSku(row)}, ${localVariantNameVi.trim()},
           ${localPriceVnd}, 'CUSTOM', 'CREDENTIAL', 0, 'SUPPLIER_ONLY',
           'SUPPLIER_API', '[]'::jsonb, null, false, true, false)
      `.execute(trx);
    }

    if (!productId || !variantId) throw new Error("SUPPLIER_TARGET_VARIANT_NOT_FOUND");

    let supplierSkuId = row.supplier_sku_id;
    if (!supplierSkuId) {
      const duplicate = await sql<{ id: string }>`
        select id from supplier_sku
        where supplier_id = ${input.supplierId} and variant_id = ${variantId}
        limit 1
      `.execute(trx);
      if (duplicate.rows[0]) throw new Error("SUPPLIER_DUPLICATE_MAPPING");
      supplierSkuId = newId();
      await sql`
        insert into supplier_sku
          (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
        values
          (${supplierSkuId}, ${input.supplierId}, ${variantId},
           ${row.external_variant_id ? `${row.external_product_id}:${row.external_variant_id}` : row.external_product_id},
           ${row.supplier_cost_vnd}, null, 'CREDENTIAL', true)
      `.execute(trx);
    } else {
      await sql`
        update supplier_sku
        set cost_vnd = ${row.supplier_cost_vnd}, is_active = true, version = version + 1
        where id = ${supplierSkuId} and variant_id = ${variantId}
      `.execute(trx);
    }

    const makePrimary =
      input.makePrimary ?? (row.local_variant_id === null && !input.targetVariantId);
    if (makePrimary) {
      await sql`
        update product_variant
        set supplier_sku_id = ${supplierSkuId}, is_active = true,
            updated_at = now(), version = version + 1
        where id = ${variantId}
      `.execute(trx);
    } else {
      await sql`
        update product_variant
        set is_active = true, updated_at = now(), version = version + 1
        where id = ${variantId}
      `.execute(trx);
    }

    const canEnable =
      !row.is_missing && (row.availability === "AVAILABLE" || row.availability === "LOW");
    const enabled = input.enabled && canEnable;
    await sql`
      update supplier_catalog_product
      set selection_status = 'SELECTED', is_enabled = ${enabled},
          local_product_id = ${productId}, local_variant_id = ${variantId},
          supplier_sku_id = ${supplierSkuId}, local_name_vi = ${localNameVi.trim()},
          local_variant_name_vi = ${localVariantNameVi.trim()},
          local_description_vi = ${localDescriptionVi.trim()}, updated_at = now(),
          version = version + 1
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
    `.execute(trx);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorId,
      action: "supplier.catalog.configure",
      targetType: "SupplierCatalogProduct",
      targetId: input.catalogId,
      reason: "Owner configured supplier product mapping",
      correlationId: input.correlationId,
      metadataRedacted: {
        supplierId: input.supplierId,
        productId,
        variantId,
        supplierSkuId,
        enabled,
        primary: makePrimary,
        priceVnd: localPriceVnd.toString(),
      },
    });
    return { enabled, productId, variantId, supplierSkuId, primary: makePrimary };
  });
}

export async function setSupplierCatalogEnabled(
  db: Db,
  input: {
    supplierId: string;
    catalogId: string;
    enabled: boolean;
    expectedVersion: number;
    actorId: string;
    correlationId: string;
  },
): Promise<{ enabled: boolean }> {
  return withTransaction(db, async (trx) => {
    const locked = await sql<{
      version: number;
      availability: SupplierAvailability;
      is_missing: boolean;
      selection_status: SupplierSelectionStatus;
    }>`
      select version, availability, is_missing, selection_status
      from supplier_catalog_product
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
      for update
    `.execute(trx);
    const row = locked.rows[0];
    if (!row) throw new Error("SUPPLIER_CATALOG_NOT_FOUND");
    if (row.version !== input.expectedVersion) throw new Error("SUPPLIER_STALE_VERSION");
    if (
      input.enabled &&
      (row.selection_status !== "SELECTED" ||
        row.is_missing ||
        !["AVAILABLE", "LOW"].includes(row.availability))
    ) {
      throw new Error("SUPPLIER_PRODUCT_UNAVAILABLE");
    }
    await sql`
      update supplier_catalog_product
      set is_enabled = ${input.enabled}, updated_at = now(), version = version + 1
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
    `.execute(trx);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorId,
      action: input.enabled ? "supplier.catalog.enable" : "supplier.catalog.disable",
      targetType: "SupplierCatalogProduct",
      targetId: input.catalogId,
      reason: input.enabled ? "Owner enabled supplier mapping" : "Owner disabled supplier mapping",
      correlationId: input.correlationId,
      metadataRedacted: { supplierId: input.supplierId, enabled: input.enabled },
    });
    return { enabled: input.enabled };
  });
}

export async function setSupplierCatalogPrimary(
  db: Db,
  input: {
    supplierId: string;
    catalogId: string;
    expectedVersion: number;
    actorId: string;
    correlationId: string;
  },
): Promise<{ variantId: string; supplierSkuId: string }> {
  return withTransaction(db, async (trx) => {
    const locked = await sql<{
      version: number;
      availability: SupplierAvailability;
      is_missing: boolean;
      selection_status: SupplierSelectionStatus;
      is_enabled: boolean;
      local_variant_id: string | null;
      supplier_sku_id: string | null;
    }>`
      select version, availability, is_missing, selection_status, is_enabled,
             local_variant_id, supplier_sku_id
      from supplier_catalog_product
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
      for update
    `.execute(trx);
    const row = locked.rows[0];
    if (!row) throw new Error("SUPPLIER_CATALOG_NOT_FOUND");
    if (row.version !== input.expectedVersion) throw new Error("SUPPLIER_STALE_VERSION");
    if (
      !row.local_variant_id ||
      !row.supplier_sku_id ||
      !row.is_enabled ||
      row.is_missing ||
      row.selection_status !== "SELECTED" ||
      !["AVAILABLE", "LOW"].includes(row.availability)
    ) {
      throw new Error("SUPPLIER_PRIMARY_UNAVAILABLE");
    }
    await sql`
      update product_variant
      set supplier_sku_id = ${row.supplier_sku_id}, updated_at = now(), version = version + 1
      where id = ${row.local_variant_id}
    `.execute(trx);
    await sql`
      update supplier_catalog_product
      set updated_at = now(), version = version + 1
      where id = ${input.catalogId} and supplier_id = ${input.supplierId}
    `.execute(trx);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.actorId,
      action: "supplier.catalog.primary",
      targetType: "SupplierCatalogProduct",
      targetId: input.catalogId,
      reason: "Owner selected primary supplier mapping",
      correlationId: input.correlationId,
      metadataRedacted: {
        supplierId: input.supplierId,
        variantId: row.local_variant_id,
        supplierSkuId: row.supplier_sku_id,
      },
    });
    return { variantId: row.local_variant_id, supplierSkuId: row.supplier_sku_id };
  });
}
