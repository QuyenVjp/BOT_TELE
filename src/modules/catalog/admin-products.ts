import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import { newId } from "../../shared/ids/index.js";
import { isValidFileArtifactRegistrationMetadata } from "../digital-goods/file-artifacts.js";
import type { FulfillmentType, InventoryField } from "./fulfillment-type.js";

export interface AdminProductInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  categoryId: string;
  name: string;
  slug: string;
  sku: string;
  description?: string;
  priceVnd: bigint;
  reason: string;
  variantName: string;
  fulfillmentType: FulfillmentType;
  inventoryFields: InventoryField[];
  lowStockThreshold: number | null;
  serviceInstructions?: string;
  initialQuantity?: number;
  fileArtifact?: {
    filename: string;
    mimeType: string;
    sizeBytes: bigint;
    sha256: string;
    storageReference: string;
  };
  active?: boolean;
  supplierConfig?: {
    supplierId: string;
    externalSku: string;
    costVnd: bigint;
    region?: string;
  };
  correlationId: string;
}

export interface AdminProductSummary {
  id: string;
  variantId: string;
  name: string;
  sku: string;
  priceVnd: bigint;
  active: boolean;
  fulfillmentType: FulfillmentType;
  lowStockThreshold: number | null;
}
export interface AdminProductDetail extends AdminProductSummary {
  categoryId: string;
  slug: string;
  description: string | null;
}

export interface AdminVariantMutationInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  variantId: string;
  reason: string;
  correlationId: string;
}

export interface AdminVariantCreateInput extends AdminVariantMutationInput {
  productId: string;
  sku: string;
  name: string;
  priceVnd: bigint;
  durationCode?: string;
  warrantyDays?: number;
  fulfillmentType: FulfillmentType;
  inventoryFields: InventoryField[];
  lowStockThreshold: number | null;
  serviceInstructions?: string;
  initialQuantity?: number;
  fileArtifact?: AdminProductInput["fileArtifact"];
  supplierConfig?: AdminProductInput["supplierConfig"];
  active?: boolean;
}

export interface AdminVariantUpdateInput extends AdminVariantMutationInput {
  expectedVersion: number;
  productId: string;
  name?: string;
  priceVnd?: bigint;
  durationCode?: string;
  warrantyDays?: number;
  active?: boolean;
  lowStockThreshold?: number | null;
}
export interface AdminProductMutation {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  productId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  priceVnd?: bigint;
  reason: string;
  correlationId: string;
}

function validate(input: AdminProductInput): void {
  if (!input.name.trim() || input.name.length > 200) throw new Error("INVALID_NAME");
  if (!input.variantName.trim() || input.variantName.length > 200)
    throw new Error("INVALID_VARIANT_NAME");
  if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.slug)) throw new Error("INVALID_SLUG");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sku)) throw new Error("INVALID_SKU");
  if (input.priceVnd < 0n) throw new Error("INVALID_PRICE");
  if ((input.description ?? "").length > 2_000) throw new Error("INVALID_DESCRIPTION");
  if ((input.lowStockThreshold ?? 0) < 0) throw new Error("INVALID_THRESHOLD");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");
  if (
    input.fulfillmentType === "DIGITAL_FILE" &&
    input.fileArtifact !== undefined &&
    !isValidFileArtifactRegistrationMetadata({
      ...input.fileArtifact,
      version: 1,
      reason: input.reason,
    })
  )
    throw new Error("INVALID_FILE_ARTIFACT");
  if (input.fulfillmentType === "SUPPLIER_API" && !input.supplierConfig)
    throw new Error("INVALID_SUPPLIER_CONFIG");
}

function legacyRoutingFor(type: FulfillmentType): {
  deliveryType: "CREDENTIAL" | "ACTIVATION_KEY";
  stockPolicy: "LOCAL_ONLY" | "SUPPLIER_ONLY" | "PAUSED";
} {
  if (type === "STOCK_CODE") return { deliveryType: "ACTIVATION_KEY", stockPolicy: "LOCAL_ONLY" };
  if (type === "SUPPLIER_API") return { deliveryType: "CREDENTIAL", stockPolicy: "SUPPLIER_ONLY" };
  return { deliveryType: "CREDENTIAL", stockPolicy: "LOCAL_ONLY" };
}

async function authorize(input: AdminProductInput): Promise<void> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "product.create",
    targetType: "Product",
    targetId: input.sku,
  });
  if (!gate.ok) throw new Error(gate.reason);
}

export async function createAdminProduct(input: AdminProductInput): Promise<AdminProductSummary> {
  validate(input);
  await authorize(input);
  return withTransaction(input.db, async (trx) => {
    const productId = newId();
    const variantId = newId();
    const product = await sql<{
      id: string;
    }>`insert into product (id, category_id, name_vi, slug, short_description_vi) values (${productId}, ${input.categoryId}, ${input.name.trim()}, ${input.slug}, ${input.description ?? null}) returning id`.execute(
      trx,
    );
    if (!product.rows[0]) throw new Error("CATEGORY_NOT_FOUND");
    const routing = legacyRoutingFor(input.fulfillmentType);
    await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, inventory_fields, low_stock_threshold, is_active) values (${variantId}, ${productId}, ${input.sku}, ${input.variantName.trim()}, ${input.priceVnd.toString()}, 'CUSTOM', ${routing.deliveryType}, ${routing.stockPolicy}, ${input.fulfillmentType}, ${JSON.stringify(input.inventoryFields)}::jsonb, ${input.lowStockThreshold}, ${input.active ?? true})`.execute(
      trx,
    );
    if (
      ["MANUAL_FULFILLMENT", "UNLIMITED_SERVICE", "QUANTITY_STOCK"].includes(input.fulfillmentType)
    ) {
      await sql`insert into variant_service_fulfillment (variant_id, fulfillment_type, instructions) values (${variantId}, ${input.fulfillmentType}, ${input.serviceInstructions ?? "Xử lý đơn hàng theo quy trình vận hành."})`.execute(
        trx,
      );
    }
    if (input.fulfillmentType === "QUANTITY_STOCK") {
      const initialQuantity = input.initialQuantity ?? 0;
      await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${variantId}, ${initialQuantity})`.execute(
        trx,
      );
      if (initialQuantity > 0) {
        await sql`insert into quantity_stock_ledger (id, variant_id, entry_type, quantity_delta, quantity_after) values (${newId()}, ${variantId}, 'ADJUST', ${initialQuantity}, ${initialQuantity})`.execute(
          trx,
        );
      }
    }
    if (input.fulfillmentType === "DIGITAL_FILE" && input.fileArtifact) {
      await sql`
        insert into variant_file_artifact
          (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, is_active)
        values (${newId()}, ${variantId}, 1, ${input.fileArtifact.filename.trim()}, ${input.fileArtifact.mimeType.trim()}, ${input.fileArtifact.sizeBytes.toString()}, ${input.fileArtifact.sha256}, ${input.fileArtifact.storageReference.trim()}, false)
      `.execute(trx);
    }
    if (input.fulfillmentType === "SUPPLIER_API" && input.supplierConfig) {
      const activeSupplier = await sql<{
        id: string;
      }>`select id from supplier where id = ${input.supplierConfig.supplierId} and status = 'ACTIVE' limit 1 for update`.execute(
        trx,
      );
      if (!activeSupplier.rows[0]) throw new Error("INVALID_SUPPLIER_CONFIG");
      const supplierSkuId = newId();
      await sql`
        insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
        values (${supplierSkuId}, ${input.supplierConfig.supplierId}, ${variantId}, ${input.supplierConfig.externalSku.trim()}, ${input.supplierConfig.costVnd.toString()}, ${input.supplierConfig.region ?? null}, ${routing.deliveryType}, true)
      `.execute(trx);
      await sql`update product_variant set supplier_sku_id = ${supplierSkuId} where id = ${variantId}`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.created",
      targetType: "Product",
      targetId: productId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: {
        sku: input.sku,
        priceVnd: input.priceVnd.toString(),
        fulfillmentType: input.fulfillmentType,
        lowStockThreshold: input.lowStockThreshold,
      },
    });
    return {
      id: productId,
      variantId,
      name: input.name.trim(),
      sku: input.sku,
      priceVnd: input.priceVnd,
      active: input.active ?? true,
      fulfillmentType: input.fulfillmentType,
      lowStockThreshold: input.lowStockThreshold,
    };
  });
}

export async function updateAdminVariantPrice(
  db: Db,
  actor: RootActor,
  config: RootAdminConfig,
  variantId: string,
  priceVnd: bigint,
  reason: string,
  correlationId: string,
): Promise<boolean> {
  if (priceVnd < 0n || !reason.trim() || reason.length > 500) throw new Error("INVALID_INPUT");
  const gate = await guardRootAction(db, {
    actor,
    config,
    correlationId,
    action: "product.price_changed",
    targetType: "ProductVariant",
    targetId: variantId,
  });
  if (!gate.ok) throw new Error(gate.reason);
  return withTransaction(db, async (trx) => {
    const result = await sql<{
      id: string;
    }>`update product_variant set price_vnd = ${priceVnd.toString()}, updated_at = now(), version = version + 1 where id = ${variantId} returning id`.execute(
      trx,
    );
    if (!result.rows[0]) return false;
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(actor.numericUserId),
      action: "product.price_changed",
      targetType: "ProductVariant",
      targetId: variantId,
      reason: reason.trim(),
      correlationId,
      metadataRedacted: { priceVnd: priceVnd.toString() },
    });
    return true;
  });
}

function validateVariantCreate(input: AdminVariantCreateInput): void {
  if (!input.productId.trim()) throw new Error("INVALID_PRODUCT");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sku)) throw new Error("INVALID_SKU");
  if (!input.name.trim() || input.name.length > 200) throw new Error("INVALID_VARIANT_NAME");
  if (input.priceVnd <= 0n) throw new Error("INVALID_PRICE");
  if (input.durationCode !== undefined && !input.durationCode.trim())
    throw new Error("INVALID_DURATION");
  if (
    input.warrantyDays !== undefined &&
    (!Number.isInteger(input.warrantyDays) || input.warrantyDays < 0)
  )
    throw new Error("INVALID_WARRANTY");
  if ((input.lowStockThreshold ?? 0) < 0) throw new Error("INVALID_THRESHOLD");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");
  if (
    input.fulfillmentType === "DIGITAL_FILE" &&
    input.fileArtifact !== undefined &&
    !isValidFileArtifactRegistrationMetadata({
      ...input.fileArtifact,
      version: 1,
      reason: input.reason,
    })
  )
    throw new Error("INVALID_FILE_ARTIFACT");
  if (input.fulfillmentType === "SUPPLIER_API" && !input.supplierConfig)
    throw new Error("INVALID_SUPPLIER_CONFIG");
}

function validateVariantUpdate(input: AdminVariantUpdateInput): void {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new Error("INVALID_VERSION");
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 200))
    throw new Error("INVALID_VARIANT_NAME");
  if (input.priceVnd !== undefined && input.priceVnd <= 0n) throw new Error("INVALID_PRICE");
  if (input.durationCode !== undefined && !input.durationCode.trim())
    throw new Error("INVALID_DURATION");
  if (
    input.warrantyDays !== undefined &&
    (!Number.isInteger(input.warrantyDays) || input.warrantyDays < 0)
  )
    throw new Error("INVALID_WARRANTY");
  if (input.lowStockThreshold !== undefined && (input.lowStockThreshold ?? 0) < 0)
    throw new Error("INVALID_THRESHOLD");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");
}

async function authorizeVariant(input: AdminVariantMutationInput, action: string): Promise<void> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action,
    targetType: "ProductVariant",
    targetId: input.variantId,
  });
  if (!gate.ok) throw new Error(gate.reason);
}

export async function createAdminVariant(
  input: AdminVariantCreateInput,
): Promise<AdminProductSummary> {
  validateVariantCreate(input);
  await authorizeVariant(input, "product.variant_created");
  return withTransaction(input.db, async (trx) => {
    const product = await sql<{
      name: string;
    }>`select name_vi as name from product where id = ${input.productId} for update`.execute(trx);
    if (!product.rows[0]) throw new Error("PRODUCT_NOT_FOUND");
    const routing = legacyRoutingFor(input.fulfillmentType);
    await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, warranty_days, delivery_type, stock_policy, fulfillment_type, inventory_fields, low_stock_threshold, is_active) values (${input.variantId}, ${input.productId}, ${input.sku.trim()}, ${input.name.trim()}, ${input.priceVnd.toString()}, ${input.durationCode?.trim() ?? "CUSTOM"}, ${input.warrantyDays ?? 0}, ${routing.deliveryType}, ${routing.stockPolicy}, ${input.fulfillmentType}, ${JSON.stringify(input.inventoryFields)}::jsonb, ${input.lowStockThreshold}, ${input.active ?? true})`.execute(
      trx,
    );
    if (
      ["MANUAL_FULFILLMENT", "UNLIMITED_SERVICE", "QUANTITY_STOCK"].includes(input.fulfillmentType)
    ) {
      await sql`insert into variant_service_fulfillment (variant_id, fulfillment_type, instructions) values (${input.variantId}, ${input.fulfillmentType}, ${input.serviceInstructions ?? "Xử lý đơn hàng theo quy trình vận hành."})`.execute(
        trx,
      );
    }
    if (input.fulfillmentType === "QUANTITY_STOCK") {
      const initialQuantity = input.initialQuantity ?? 0;
      await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${input.variantId}, ${initialQuantity})`.execute(
        trx,
      );
      if (initialQuantity > 0)
        await sql`insert into quantity_stock_ledger (id, variant_id, entry_type, quantity_delta, quantity_after) values (${newId()}, ${input.variantId}, 'ADJUST', ${initialQuantity}, ${initialQuantity})`.execute(
          trx,
        );
    }
    if (input.fulfillmentType === "DIGITAL_FILE" && input.fileArtifact) {
      await sql`insert into variant_file_artifact (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, is_active) values (${newId()}, ${input.variantId}, 1, ${input.fileArtifact.filename.trim()}, ${input.fileArtifact.mimeType.trim()}, ${input.fileArtifact.sizeBytes.toString()}, ${input.fileArtifact.sha256}, ${input.fileArtifact.storageReference.trim()}, false)`.execute(
        trx,
      );
    }
    if (input.fulfillmentType === "SUPPLIER_API" && input.supplierConfig) {
      const activeSupplier = await sql<{
        id: string;
      }>`select id from supplier where id = ${input.supplierConfig.supplierId} and status = 'ACTIVE' limit 1 for update`.execute(
        trx,
      );
      if (!activeSupplier.rows[0]) throw new Error("INVALID_SUPPLIER_CONFIG");
      const supplierSkuId = newId();
      await sql`insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active) values (${supplierSkuId}, ${input.supplierConfig.supplierId}, ${input.variantId}, ${input.supplierConfig.externalSku.trim()}, ${input.supplierConfig.costVnd.toString()}, ${input.supplierConfig.region ?? null}, ${routing.deliveryType}, true)`.execute(
        trx,
      );
      await sql`update product_variant set supplier_sku_id = ${supplierSkuId} where id = ${input.variantId}`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.variant_created",
      targetType: "ProductVariant",
      targetId: input.variantId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: {
        productId: input.productId,
        sku: input.sku,
        priceVnd: input.priceVnd.toString(),
        ...(input.durationCode === undefined ? {} : { durationCode: input.durationCode }),
        ...(input.warrantyDays === undefined ? {} : { warrantyDays: input.warrantyDays }),
        fulfillmentType: input.fulfillmentType,
        lowStockThreshold: input.lowStockThreshold,
      },
    });
    return {
      id: input.productId,
      variantId: input.variantId,
      name: product.rows[0].name,
      sku: input.sku.trim(),
      priceVnd: input.priceVnd,
      active: input.active ?? true,
      fulfillmentType: input.fulfillmentType,
      lowStockThreshold: input.lowStockThreshold,
    };
  });
}

export async function updateAdminVariant(input: AdminVariantUpdateInput): Promise<boolean> {
  validateVariantUpdate(input);
  await authorizeVariant(input, "product.variant_updated");
  return withTransaction(input.db, async (trx) => {
    const result = await sql<{ id: string }>`
      update product_variant
      set name_vi = coalesce(${input.name?.trim() ?? null}, name_vi),
          price_vnd = coalesce(${input.priceVnd?.toString() ?? null}, price_vnd),
          duration_code = coalesce(${input.durationCode?.trim() ?? null}, duration_code),
          warranty_days = coalesce(${input.warrantyDays ?? null}, warranty_days),
          is_active = coalesce(${input.active ?? null}, is_active),
          low_stock_threshold = ${input.lowStockThreshold === undefined ? sql`low_stock_threshold` : input.lowStockThreshold},
          updated_at = now(),
          version = version + 1
      where id = ${input.variantId} and product_id = ${input.productId} and version = ${input.expectedVersion}
      returning id
    `.execute(trx);
    if (!result.rows[0]) return false;
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.variant_updated",
      targetType: "ProductVariant",
      targetId: input.variantId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: {
        productId: input.productId,
        expectedVersion: input.expectedVersion,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.priceVnd === undefined ? {} : { priceVnd: input.priceVnd.toString() }),
        ...(input.durationCode === undefined ? {} : { durationCode: input.durationCode }),
        ...(input.warrantyDays === undefined ? {} : { warrantyDays: input.warrantyDays }),
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.lowStockThreshold === undefined
          ? {}
          : { lowStockThreshold: input.lowStockThreshold }),
      },
    });
    return true;
  });
}
