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
  description?: string | undefined;
  /** Short one-line description shown in listings. Distinct from the full description. */
  shortDescriptionVi?: string | undefined;
  descriptionVi?: string | undefined;
  whatCustomerReceivesVi?: string | undefined;
  usageInstructionsVi?: string | undefined;
  deliveryEtaVi?: string | undefined;
  warrantyVi?: string | undefined;
  supportVi?: string | undefined;
  termsVi?: string | undefined;
  tags?: string[] | undefined;
  compareAtPriceVnd?: bigint | undefined;
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
  isTest?: boolean;
  isArchived?: boolean;
  visibility?: "PUBLIC" | "TEST_ONLY" | "DRAFT";
  isFeatured?: boolean;
  featuredRank?: number;
  preorderEnabled?: boolean;
  /**
   * Warranty policy (goal: warranty vertical). Structured so the customer can be shown a specific
   * coverage and a claim can prove which policy it was judged under.
   */
  warrantyEnabled?: boolean;
  warrantyDays?: number;
  warrantyProrationEnabled?: boolean;
  warrantyReplacementAllowed?: boolean;
  warrantyRefundAllowed?: boolean;
  warrantyReplacementBehavior?: "CONTINUE_ORIGINAL_END" | "RESET_FROM_REPLACEMENT";
  warrantyCoverageVi?: string;
  warrantyExclusionsVi?: string;
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

export interface AdminProductUpdateInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  productId: string;
  expectedVersion: number;
  name?: string;
  slug?: string;
  description?: string | null;
  active?: boolean;
  isTest?: boolean;
  isArchived?: boolean;
  visibility?: "PUBLIC" | "TEST_ONLY" | "DRAFT";
  isFeatured?: boolean;
  featuredRank?: number;
  reason: string;
  correlationId: string;
}

export async function updateAdminProduct(input: AdminProductUpdateInput): Promise<boolean> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new Error("INVALID_VERSION");
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 200))
    throw new Error("INVALID_NAME");
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.slug))
    throw new Error("INVALID_SLUG");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");

  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "product.updated",
    targetType: "Product",
    targetId: input.productId,
  });
  if (!gate.ok) throw new Error(gate.reason);

  return withTransaction(input.db, async (trx) => {
    const existing = await sql<{
      is_test: boolean;
      is_active: boolean;
      is_archived: boolean;
    }>`
      select is_test, is_active, is_archived
      from product
      where id = ${input.productId} and version = ${input.expectedVersion}
      for update
    `.execute(trx);
    const curr = existing.rows[0];
    if (!curr) return false;

    const mergedTest = input.isTest !== undefined ? input.isTest : curr.is_test;
    const mergedArchived = input.isArchived !== undefined ? input.isArchived : curr.is_archived;
    const mergedActive = input.active !== undefined ? input.active : curr.is_active;
    const mergedVisibility =
      input.visibility ??
      (mergedTest ? "TEST_ONLY" : mergedArchived ? "DRAFT" : mergedActive ? "PUBLIC" : "DRAFT");

    validateProductVisibilityInvariant({
      isTest: mergedTest,
      active: mergedActive,
      visibility: mergedVisibility,
      isArchived: mergedArchived,
    });

    const result = await sql<{ id: string }>`
      update product
      set name_vi = coalesce(${input.name?.trim() ?? null}, name_vi),
          slug = coalesce(${input.slug ?? null}, slug),
          description_vi = coalesce(${input.description ?? null}, description_vi),
          is_active = ${mergedActive},
          is_test = ${mergedTest},
          is_archived = ${mergedArchived},
          is_featured = coalesce(${input.isFeatured ?? null}, is_featured),
          featured_rank = coalesce(${input.featuredRank ?? null}, featured_rank),
          updated_at = now(),
          version = version + 1
      where id = ${input.productId} and version = ${input.expectedVersion}
      returning id
    `.execute(trx);
    if (!result.rows[0]) return false;
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.updated",
      targetType: "Product",
      targetId: input.productId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: {
        isTest: input.isTest ?? null,
        active: input.active ?? null,
        visibility: input.visibility ?? null,
      },
    });
    return true;
  });
}

export function validateProductVisibilityInvariant(input: {
  isTest?: boolean | undefined;
  active?: boolean | undefined;
  visibility?: "PUBLIC" | "TEST_ONLY" | "DRAFT" | undefined;
  isArchived?: boolean | undefined;
}): void {
  const isTest = input.isTest === true;
  const active = input.active !== false; // defaults to true unless explicitly false
  const visibility = input.visibility ?? (isTest ? "TEST_ONLY" : "PUBLIC");
  const isArchived = input.isArchived === true;

  if (isTest && visibility === "PUBLIC") {
    throw new Error("INVALID_TEST_VISIBILITY: Test product cannot have PUBLIC visibility");
  }
  if (isTest && active && visibility !== "TEST_ONLY") {
    throw new Error("INVALID_TEST_VISIBILITY: Active test product requires TEST_ONLY visibility");
  }
  // Symmetric rule: a caller that asks for TEST_ONLY on a non-test product is asking for a
  // narrowed audience the persistence layer cannot represent (the row would land is_test=false,
  // is_active=true and then DERIVE to PUBLIC). Failing closed here keeps the invariant total —
  // without it, "TEST_ONLY" would be silently upgraded to a publicly listed product.
  if (!isTest && visibility === "TEST_ONLY") {
    throw new Error("INVALID_TEST_VISIBILITY: Non-test product cannot have TEST_ONLY visibility");
  }
  if (isArchived && active && visibility === "PUBLIC") {
    throw new Error("INVALID_ARCHIVED_VISIBILITY: Archived product cannot be active public");
  }
  if (visibility === "DRAFT" && active) {
    throw new Error("INVALID_DRAFT_STATE: DRAFT product cannot be active");
  }
}

function validate(input: AdminProductInput): void {
  validateProductVisibilityInvariant({
    isTest: input.isTest,
    active: input.active,
    visibility: input.visibility,
    isArchived: input.isArchived,
  });
  if (!input.name.trim() || input.name.length > 200) throw new Error("INVALID_NAME");
  if (!input.variantName.trim() || input.variantName.length > 200)
    throw new Error("INVALID_VARIANT_NAME");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.slug)) throw new Error("INVALID_SLUG");
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
    }>`insert into product (id, category_id, name_vi, slug, short_description_vi, description_vi, what_customer_receives_vi, usage_instructions_vi, delivery_eta_vi, warranty_vi, support_vi, terms_vi, tags, is_test, is_active, is_archived, is_featured, featured_rank) values (${productId}, ${input.categoryId}, ${input.name.trim()}, ${input.slug}, ${input.shortDescriptionVi ?? input.description ?? null}, ${input.descriptionVi ?? null}, ${input.whatCustomerReceivesVi ?? null}, ${input.usageInstructionsVi ?? null}, ${input.deliveryEtaVi ?? null}, ${input.warrantyVi ?? null}, ${input.supportVi ?? null}, ${input.termsVi ?? null}, ${input.tags ?? null}, ${input.isTest ?? false}, ${input.active ?? true}, ${input.isArchived ?? false}, ${input.isFeatured ?? false}, ${input.featuredRank ?? 0}) returning id`.execute(
      trx,
    );
    if (!product.rows[0]) throw new Error("CATEGORY_NOT_FOUND");
    const routing = legacyRoutingFor(input.fulfillmentType);
    await sql`insert into product_variant (id, product_id, sku, name_vi, price_vnd, compare_at_price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, inventory_fields, low_stock_threshold, preorder_enabled, is_active, warranty_enabled, warranty_days, warranty_proration_enabled, warranty_replacement_allowed, warranty_refund_allowed, warranty_replacement_behavior, warranty_coverage_vi, warranty_exclusions_vi) values (${variantId}, ${productId}, ${input.sku}, ${input.variantName.trim()}, ${input.priceVnd.toString()}, ${input.compareAtPriceVnd?.toString() ?? null}, 'CUSTOM', ${routing.deliveryType}, ${routing.stockPolicy}, ${input.fulfillmentType}, ${JSON.stringify(input.inventoryFields)}::jsonb, ${input.lowStockThreshold}, ${input.preorderEnabled ?? false}, ${input.active ?? true}, ${input.warrantyEnabled ?? false}, ${input.warrantyEnabled ? (input.warrantyDays ?? 0) : 0}, ${input.warrantyProrationEnabled ?? true}, ${input.warrantyReplacementAllowed ?? true}, ${input.warrantyRefundAllowed ?? true}, ${input.warrantyReplacementBehavior ?? "CONTINUE_ORIGINAL_END"}, ${input.warrantyCoverageVi ?? null}, ${input.warrantyExclusionsVi ?? null})`.execute(
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

/**
 * Goal §81 — edit a product's commercial content without recreating it.
 *
 * Whitelisted single-field update: the owner edits one field at a time from the product screen, so
 * an arbitrary column name or an arbitrary statement is never in reach. The same root gate and the
 * same audit trail as `updateAdminProduct` apply, and the optimistic `version` guard is kept.
 */
export const ADMIN_PRODUCT_CONTENT_FIELDS = {
  name: "name_vi",
  shortDescription: "short_description_vi",
  description: "description_vi",
  whatCustomerReceives: "what_customer_receives_vi",
  usageInstructions: "usage_instructions_vi",
  warranty: "warranty_vi",
  deliveryEta: "delivery_eta_vi",
  terms: "terms_vi",
  support: "support_vi",
  /** Comma-separated in the UI; stored as the text[] the search predicate reads. */
  tags: "tags",
} as const;

/** Fields whose column is a text[] rather than text. */
const ARRAY_CONTENT_FIELDS: ReadonlySet<string> = new Set(["tags"]);

export type AdminProductContentField = keyof typeof ADMIN_PRODUCT_CONTENT_FIELDS;

export interface AdminProductContentUpdateInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  productId: string;
  expectedVersion: number;
  field: string;
  /** Trimmed value; an empty string clears the field. */
  value: string;
  reason: string;
  correlationId: string;
}

export async function updateAdminProductContent(
  input: AdminProductContentUpdateInput,
): Promise<boolean> {
  const column = ADMIN_PRODUCT_CONTENT_FIELDS[input.field as AdminProductContentField];
  if (!column) throw new Error("INVALID_CONTENT_FIELD");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new Error("INVALID_VERSION");
  const value = input.value.trim();
  if (value.length > 2_000) throw new Error("INVALID_CONTENT_LENGTH");
  if (input.field === "name" && value.length === 0) throw new Error("INVALID_NAME");
  if (!input.reason.trim() || input.reason.length > 500) throw new Error("INVALID_REASON");

  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "product.content_updated",
    targetType: "Product",
    targetId: input.productId,
  });
  if (!gate.ok) throw new Error(gate.reason);

  return withTransaction(input.db, async (trx) => {
    const result = await sql<{ id: string }>`
      update product
      set ${
        ARRAY_CONTENT_FIELDS.has(input.field)
          ? sql`${sql.ref(column)} = ${
              value.length === 0
                ? sql`'{}'::text[]`
                : // Trim each term and drop the empties, so "claude, pro" never stores " pro".
                  sql`array(
                    select btrim(term)
                    from unnest(string_to_array(${value}, ',')) as term
                    where btrim(term) <> ''
                  )::text[]`
            }`
          : sql`${sql.ref(column)} = ${value.length === 0 ? null : value}`
      },
          updated_at = now(),
          version = version + 1
      where id = ${input.productId} and version = ${input.expectedVersion}
      returning id
    `.execute(trx);
    if (!result.rows[0]) return false;
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "product.content_updated",
      targetType: "Product",
      targetId: input.productId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      metadataRedacted: { field: input.field, cleared: value.length === 0 },
    });
    return true;
  });
}
