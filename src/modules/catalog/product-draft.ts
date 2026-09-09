import { sql, type Kysely } from "kysely";
import type { Database } from "../../infrastructure/db/client.js";
import {
  FULFILLMENT_TYPES,
  INVENTORY_FIELDS_SCHEMA,
  type FulfillmentType,
  type InventoryField,
} from "./fulfillment-type.js";

export type ProductDraftStep =
  | "name"
  | "sku"
  | "category"
  | "productType"
  | "description"
  | "variant"
  | "deliveryConfig"
  | "confirm"
  | "variantName"
  | "price"
  | "fulfillmentType"
  | "serviceInstructions"
  | "initialQuantity"
  | "fileArtifact"
  | "supplierConfig"
  | "inventoryFields"
  | "threshold";

export interface DeliveryConfigState {
  selectedOptionalFields: string[];
  customFields: InventoryField[];
}
export interface ProductDraft {
  adminTelegramUserId: string;
  step: ProductDraftStep;
  name?: string | undefined;
  slug?: string | undefined;
  sku?: string | undefined;
  categoryId?: string | undefined;
  categoryName?: string | undefined;
  existingProductId?: string | undefined;
  priceVnd?: bigint | undefined;
  compareAtPriceVnd?: bigint | undefined;
  description?: string | undefined;
  descriptionVi?: string | undefined;
  whatCustomerReceivesVi?: string | undefined;
  usageInstructionsVi?: string | undefined;
  deliveryEtaVi?: string | undefined;
  warrantyVi?: string | undefined;
  supportVi?: string | undefined;
  termsVi?: string | undefined;
  tags?: string[] | undefined;
  lowStockThreshold?: number | undefined;
  variantName?: string | undefined;
  fulfillmentType?: FulfillmentType | undefined;
  inventoryFields?: InventoryField[] | undefined;
  deliveryConfig?: DeliveryConfigState | undefined;
  serviceInstructions?: string | undefined;
  initialQuantity?: number | undefined;
  fileArtifact?:
    | {
        filename: string;
        mimeType: string;
        sizeBytes: bigint;
        sha256: string;
        storageReference: string;
      }
    | undefined;
  supplierConfig?:
    | { supplierId: string; externalSku: string; costVnd: bigint; region?: string | undefined }
    | undefined;
  expiresAt: number;
}
export type ProductDraftFileArtifact = NonNullable<ProductDraft["fileArtifact"]>;
export type ProductDraftSupplierConfig = NonNullable<ProductDraft["supplierConfig"]>;
function fileArtifactFromStored(value: unknown): ProductDraftFileArtifact | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.filename !== "string" ||
    typeof v.mimeType !== "string" ||
    typeof v.sha256 !== "string" ||
    typeof v.storageReference !== "string" ||
    (typeof v.sizeBytes !== "string" && typeof v.sizeBytes !== "number")
  )
    return null;
  return {
    filename: v.filename,
    mimeType: v.mimeType,
    sha256: v.sha256,
    storageReference: v.storageReference,
    sizeBytes: BigInt(v.sizeBytes),
  };
}
function supplierConfigFromStored(value: unknown): ProductDraftSupplierConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.supplierId !== "string" ||
    typeof v.externalSku !== "string" ||
    (typeof v.costVnd !== "string" && typeof v.costVnd !== "number")
  )
    return null;
  return {
    supplierId: v.supplierId,
    externalSku: v.externalSku,
    costVnd: BigInt(v.costVnd),
    ...(typeof v.region === "string" ? { region: v.region } : {}),
  };
}
const TTL_MS = 15 * 60_000;
export const SKU = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
export function generateProductSlug(name: string, sku: string): string {
  const base = (name || sku || "product")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base.length >= 2 ? base : `${base || "p"}-prod`).slice(0, 100);
}
export function generateSkuProposal(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${base || "SP"}-001`;
}

const PRESETS: Record<string, InventoryField> = {
  email: { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
  username: {
    name: "username",
    label: "Tên đăng nhập",
    required: true,
    secret: false,
    customerVisible: true,
  },
  password: {
    name: "password",
    label: "Mật khẩu",
    required: true,
    secret: true,
    customerVisible: true,
  },
  recovery_email: {
    name: "recovery_email",
    label: "Email khôi phục",
    required: false,
    secret: false,
    customerVisible: true,
  },
  two_factor_secret: {
    name: "two_factor_secret",
    label: "2FA/Secret",
    required: false,
    secret: true,
    customerVisible: true,
  },
  custom_instructions: {
    name: "custom_instructions",
    label: "Hướng dẫn riêng",
    required: false,
    secret: false,
    customerVisible: true,
  },
  code: { name: "code", label: "Mã/Key", required: true, secret: true, customerVisible: true },
  note: { name: "note", label: "Ghi chú", required: false, secret: false, customerVisible: true },
  expires_at: {
    name: "expires_at",
    label: "Hạn sử dụng",
    required: false,
    secret: false,
    customerVisible: true,
  },
  file: { name: "file", label: "File", required: true, secret: false, customerVisible: true },
  file_password: {
    name: "file_password",
    label: "Mật khẩu file",
    required: false,
    secret: true,
    customerVisible: true,
  },
  instructions: {
    name: "instructions",
    label: "Hướng dẫn",
    required: false,
    secret: false,
    customerVisible: true,
  },
};
const TYPE_MAP: Record<string, FulfillmentType> = {
  ACCOUNT: "STOCK_ACCOUNT",
  CODE: "STOCK_CODE",
  FILE: "DIGITAL_FILE",
  QUANTITY: "QUANTITY_STOCK",
  UNLIMITED_SERVICE: "UNLIMITED_SERVICE",
  MANUAL: "MANUAL_FULFILLMENT",
  SUPPLIER: "SUPPLIER_API",
};
export function inventoryFieldsForType(type: FulfillmentType): InventoryField[] {
  if (type === "STOCK_ACCOUNT") return [PRESETS.email!, PRESETS.username!, PRESETS.password!];
  if (type === "STOCK_CODE") return [PRESETS.code!];
  if (type === "DIGITAL_FILE") return [PRESETS.file!];
  return [];
}
function asciiKey(label: string): string {
  const key = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "truong_tuy_chinh";
}
export function generateCustomFieldKey(label: string): string {
  return asciiKey(label);
}
export function toggleOptionalField(draft: ProductDraft, name: string): ProductDraft {
  const fields = draft.inventoryFields ?? [];
  const base = PRESETS[name];
  if (!base) return draft;
  const present = fields.some((f) => f.name === name);
  return {
    ...draft,
    inventoryFields: present ? fields.filter((f) => f.name !== name) : [...fields, base],
  };
}
export function addCustomField(draft: ProductDraft, input: { label: string }): ProductDraft {
  const name = asciiKey(input.label);
  if ((draft.inventoryFields ?? []).some((f) => f.name === name)) return draft;
  const field: InventoryField = {
    name,
    label: input.label.trim(),
    required: false,
    secret: false,
    customerVisible: true,
  };
  return {
    ...draft,
    inventoryFields: [...(draft.inventoryFields ?? []), field],
    deliveryConfig: {
      ...(draft.deliveryConfig ?? { selectedOptionalFields: [], customFields: [] }),
      customFields: [...(draft.deliveryConfig?.customFields ?? []), field],
    },
  };
}
export function setCustomFieldFlags(
  draft: ProductDraft,
  name: string,
  flags: Partial<Pick<InventoryField, "required" | "secret" | "customerVisible">>,
): ProductDraft {
  const fields = (draft.inventoryFields ?? []).map((f) =>
    f.name === name ? { ...f, ...flags } : f,
  );
  return {
    ...draft,
    inventoryFields: fields,
    deliveryConfig: draft.deliveryConfig
      ? {
          ...draft.deliveryConfig,
          customFields: draft.deliveryConfig.customFields.map((f) =>
            f.name === name ? { ...f, ...flags } : f,
          ),
        }
      : draft.deliveryConfig,
  };
}
export function removeCustomField(draft: ProductDraft, name: string): ProductDraft {
  return {
    ...draft,
    inventoryFields: (draft.inventoryFields ?? []).filter((f) => f.name !== name),
    deliveryConfig: draft.deliveryConfig
      ? {
          ...draft.deliveryConfig,
          customFields: draft.deliveryConfig.customFields.filter((f) => f.name !== name),
        }
      : draft.deliveryConfig,
  };
}
export function applyAdvancedRaw(draft: ProductDraft, text: string): ProductDraft {
  const fields = text
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => ({
      name: asciiKey(label),
      label,
      required: false,
      secret: false,
      customerVisible: true,
    }));
  const valid = INVENTORY_FIELDS_SCHEMA.safeParse(fields);
  return valid.success ? { ...draft, inventoryFields: valid.data } : draft;
}
export function previousStep(draft: ProductDraft): ProductDraft {
  const order: ProductDraftStep[] = [
    "name",
    "sku",
    "category",
    "productType",
    "description",
    "variant",
    "deliveryConfig",
    "confirm",
  ];
  const i = order.indexOf(draft.step);
  const step = order[Math.max(0, i - 1)] ?? "name";
  return { ...draft, step };
}
export type DraftResult =
  { ok: true; draft: ProductDraft } | { ok: false; error: string; draft: ProductDraft };
export function startProductDraft(adminTelegramUserId: string, now = Date.now()): ProductDraft {
  return { adminTelegramUserId, step: "name", expiresAt: now + TTL_MS };
}
export function startProductVariantDraft(
  adminTelegramUserId: string,
  productId: string,
  now = Date.now(),
): ProductDraft {
  return {
    adminTelegramUserId,
    existingProductId: productId,
    step: "sku",
    expiresAt: now + TTL_MS,
  };
}
export function advanceProductDraft(
  draft: ProductDraft,
  value: string,
  now = Date.now(),
): DraftResult {
  if (draft.expiresAt <= now) return { ok: false, error: "DRAFT_EXPIRED", draft };
  const text = value.trim();
  if (!text || text.length > 2000) return { ok: false, error: "INVALID_VALUE", draft };
  const next = { ...draft, expiresAt: now + TTL_MS };
  switch (draft.step) {
    case "name":
      next.name = text;
      next.step = "sku";
      break;
    case "sku":
      if (!SKU.test(text)) return { ok: false, error: "INVALID_SKU", draft };
      next.sku = text.toUpperCase();
      next.slug = generateProductSlug(next.name ?? "", next.sku);
      next.step = draft.existingProductId ? "productType" : "category";
      break;
    case "category":
      next.categoryId = text;
      next.step = "productType";
      break;
    case "productType": {
      const type =
        TYPE_MAP[text.toUpperCase()] ??
        (FULFILLMENT_TYPES.includes(text.toUpperCase() as FulfillmentType)
          ? (text.toUpperCase() as FulfillmentType)
          : undefined);
      if (!type) return { ok: false, error: "UNSUPPORTED_FULFILLMENT_TYPE", draft };
      next.fulfillmentType = type;
      next.inventoryFields = inventoryFieldsForType(type);
      next.deliveryConfig = { selectedOptionalFields: [], customFields: [] };
      next.step = "description";
      break;
    }
    case "description": {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(text) as Record<string, unknown>;
      } catch {
        next.descriptionVi = text;
        next.description = text;
        next.step = "variant";
        break;
      }
      if (typeof v.description === "string") {
        next.descriptionVi = v.description;
        next.description = v.description;
      }
      if (typeof v.what_customer_receives === "string")
        next.whatCustomerReceivesVi = v.what_customer_receives;
      if (typeof v.usage_instructions === "string") next.usageInstructionsVi = v.usage_instructions;
      if (typeof v.warranty === "string") next.warrantyVi = v.warranty;
      next.step = "variant";
      break;
    }
    case "variant": {
      const [name, price] = text.split("|").map((x) => x.trim());
      if (!name || !price || !/^\d+$/.test(price.replace(/[.,]/g, "")))
        return { ok: false, error: "INVALID_VARIANT", draft };
      next.variantName = name;
      next.priceVnd = BigInt(price.replace(/[.,]/g, ""));
      next.step = "deliveryConfig";
      break;
    }
    case "deliveryConfig": {
      if (draft.fulfillmentType === "SUPPLIER_API") {
        const supplierConfig = parseSupplierConfig(text);
        if (!supplierConfig) return { ok: false, error: "INVALID_SUPPLIER_CONFIG", draft };
        next.supplierConfig = supplierConfig;
      } else if (draft.fulfillmentType === "QUANTITY_STOCK") {
        if (!/^\d+$/.test(text)) return { ok: false, error: "INVALID_QUANTITY", draft };
        next.initialQuantity = Number(text);
      } else if (
        draft.fulfillmentType === "MANUAL_FULFILLMENT" ||
        draft.fulfillmentType === "UNLIMITED_SERVICE"
      )
        next.serviceInstructions = text;
      else {
        const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(draft.inventoryFields ?? []);
        if (!parsed.success) return { ok: false, error: "INVALID_INVENTORY_FIELDS", draft };
        next.inventoryFields = parsed.data;
      }
      next.step = "confirm";
      break;
    }
    case "confirm":
      return { ok: false, error: "DRAFT_READY", draft };
    default:
      return { ok: false, error: "INVALID_STEP", draft };
  }
  return { ok: true, draft: next };
}

function parseSupplierConfig(text: string): ProductDraft["supplierConfig"] | undefined {
  const [supplierId, externalSku, costVnd, region] = text.split("|").map((p) => p.trim());
  if (!supplierId || !externalSku || !costVnd || !/^\d+$/.test(costVnd)) return undefined;
  return { supplierId, externalSku, costVnd: BigInt(costVnd), ...(region ? { region } : {}) };
}

export interface ProductDraftWorkflow {
  start(adminTelegramUserId: string, now?: number): ProductDraft;
  startVariant(adminTelegramUserId: string, productId: string, now?: number): ProductDraft;
  advance(adminTelegramUserId: string, value: string, now?: number): DraftResult;
  get(adminTelegramUserId: string, now?: number): ProductDraft | null;
  cancel(adminTelegramUserId: string): void;
}

export interface ProductDraftRepository {
  save(draft: ProductDraft): Promise<void>;
  load(adminTelegramUserId: string): Promise<ProductDraft | null>;
  remove(adminTelegramUserId: string): Promise<void>;
}

type DraftRow = {
  admin_telegram_user_id: string;
  step: ProductDraftStep;
  name: string | null;
  slug: string | null;
  sku: string | null;
  category_id: string | null;
  existing_product_id: string | null;
  variant_name: string | null;
  price_vnd: string | null;
  description: string | null;
  fulfillment_type: FulfillmentType | null;
  inventory_fields: unknown;
  low_stock_threshold: number | null;
  service_instructions: string | null;
  initial_quantity: number | null;
  file_artifact: unknown;
  supplier_config: unknown;
  expires_at: Date;
  extra?: unknown;
};

/** Fields persisted via the admin_workflow.extra jsonb column (migration 045). */
type DraftExtra = {
  categoryName?: string;
  compareAtPriceVnd?: string;
  descriptionVi?: string;
  whatCustomerReceivesVi?: string;
  usageInstructionsVi?: string;
  deliveryEtaVi?: string;
  warrantyVi?: string;
  supportVi?: string;
  termsVi?: string;
  tags?: string[];
  deliveryConfig?: DeliveryConfigState;
};

function draftExtra(draft: ProductDraft): DraftExtra {
  const extra: DraftExtra = {};
  if (draft.categoryName != null) extra.categoryName = draft.categoryName;
  if (draft.compareAtPriceVnd != null) extra.compareAtPriceVnd = draft.compareAtPriceVnd.toString();
  if (draft.descriptionVi != null) extra.descriptionVi = draft.descriptionVi;
  if (draft.whatCustomerReceivesVi != null)
    extra.whatCustomerReceivesVi = draft.whatCustomerReceivesVi;
  if (draft.usageInstructionsVi != null) extra.usageInstructionsVi = draft.usageInstructionsVi;
  if (draft.deliveryEtaVi != null) extra.deliveryEtaVi = draft.deliveryEtaVi;
  if (draft.warrantyVi != null) extra.warrantyVi = draft.warrantyVi;
  if (draft.supportVi != null) extra.supportVi = draft.supportVi;
  if (draft.termsVi != null) extra.termsVi = draft.termsVi;
  if (draft.tags != null) extra.tags = draft.tags;
  if (draft.deliveryConfig != null) extra.deliveryConfig = draft.deliveryConfig;
  return extra;
}

function parseDraftExtra(value: unknown): DraftExtra {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: DraftExtra = {};
  if (typeof v.categoryName === "string") out.categoryName = v.categoryName;
  if (typeof v.compareAtPriceVnd === "string") out.compareAtPriceVnd = v.compareAtPriceVnd;
  if (typeof v.descriptionVi === "string") out.descriptionVi = v.descriptionVi;
  if (typeof v.whatCustomerReceivesVi === "string")
    out.whatCustomerReceivesVi = v.whatCustomerReceivesVi;
  if (typeof v.usageInstructionsVi === "string") out.usageInstructionsVi = v.usageInstructionsVi;
  if (typeof v.deliveryEtaVi === "string") out.deliveryEtaVi = v.deliveryEtaVi;
  if (typeof v.warrantyVi === "string") out.warrantyVi = v.warrantyVi;
  if (typeof v.supportVi === "string") out.supportVi = v.supportVi;
  if (typeof v.termsVi === "string") out.termsVi = v.termsVi;
  if (Array.isArray(v.tags)) out.tags = v.tags.filter((t): t is string => typeof t === "string");
  const dc = v.deliveryConfig;
  if (dc && typeof dc === "object") {
    const d = dc as Record<string, unknown>;
    out.deliveryConfig = {
      selectedOptionalFields: Array.isArray(d.selectedOptionalFields)
        ? d.selectedOptionalFields.filter((x): x is string => typeof x === "string")
        : [],
      customFields: Array.isArray(d.customFields)
        ? (d.customFields as DeliveryConfigState["customFields"])
        : [],
    };
  }
  return out;
}

export function createProductDraftRepository(db: Kysely<Database>): ProductDraftRepository {
  return {
    async save(draft) {
      await sql`
        insert into admin_workflow
          (admin_telegram_user_id, step, name, slug, sku, category_id, existing_product_id, variant_name, price_vnd,
           description, fulfillment_type, inventory_fields, low_stock_threshold, service_instructions,
           initial_quantity, file_artifact, supplier_config, extra, expires_at)
        values (${draft.adminTelegramUserId}, ${draft.step}, ${draft.name ?? null},
          ${draft.slug ?? null}, ${draft.sku ?? null}, ${draft.categoryId ?? null}, ${draft.existingProductId ?? null}, ${draft.variantName ?? null},
          ${draft.priceVnd?.toString() ?? null}, ${draft.description ?? null}, ${draft.fulfillmentType ?? null},
          ${JSON.stringify(draft.inventoryFields ?? [])}::jsonb, ${draft.lowStockThreshold ?? null},
          ${draft.serviceInstructions ?? null}, ${draft.initialQuantity ?? null}, ${JSON.stringify(draft.fileArtifact ? { ...draft.fileArtifact, sizeBytes: draft.fileArtifact.sizeBytes.toString() } : null)}::jsonb, ${JSON.stringify(draft.supplierConfig ? { ...draft.supplierConfig, costVnd: draft.supplierConfig.costVnd.toString() } : null)}::jsonb, ${JSON.stringify(draftExtra(draft))}::jsonb, to_timestamp(${draft.expiresAt} / 1000.0))
        on conflict (admin_telegram_user_id) do update set
          step = excluded.step, name = excluded.name, slug = excluded.slug,
          sku = excluded.sku, category_id = excluded.category_id,
          existing_product_id = excluded.existing_product_id, variant_name = excluded.variant_name, price_vnd = excluded.price_vnd,
          description = excluded.description, fulfillment_type = excluded.fulfillment_type,
          inventory_fields = excluded.inventory_fields,
          low_stock_threshold = excluded.low_stock_threshold,
          service_instructions = excluded.service_instructions,
          initial_quantity = excluded.initial_quantity,
          file_artifact = excluded.file_artifact,
          supplier_config = excluded.supplier_config,
          extra = excluded.extra,
          expires_at = excluded.expires_at, updated_at = now()
      `.execute(db);
    },
    async load(adminTelegramUserId) {
      const result = await sql<DraftRow>`select * from admin_workflow
        where admin_telegram_user_id = ${adminTelegramUserId}`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      const extra = parseDraftExtra(row.extra);
      return {
        adminTelegramUserId: row.admin_telegram_user_id,
        step: row.step,
        ...(row.name == null ? {} : { name: row.name }),
        ...(row.slug == null ? {} : { slug: row.slug }),
        ...(row.sku == null ? {} : { sku: row.sku }),
        ...(row.category_id == null ? {} : { categoryId: row.category_id }),
        ...(extra.categoryName == null ? {} : { categoryName: extra.categoryName }),
        ...(row.existing_product_id == null ? {} : { existingProductId: row.existing_product_id }),
        ...(row.variant_name == null ? {} : { variantName: row.variant_name }),
        ...(row.price_vnd == null ? {} : { priceVnd: BigInt(row.price_vnd) }),
        ...(extra.compareAtPriceVnd == null
          ? {}
          : { compareAtPriceVnd: BigInt(extra.compareAtPriceVnd) }),
        ...(row.description == null ? {} : { description: row.description }),
        ...(extra.descriptionVi == null ? {} : { descriptionVi: extra.descriptionVi }),
        ...(extra.whatCustomerReceivesVi == null
          ? {}
          : { whatCustomerReceivesVi: extra.whatCustomerReceivesVi }),
        ...(extra.usageInstructionsVi == null
          ? {}
          : { usageInstructionsVi: extra.usageInstructionsVi }),
        ...(extra.deliveryEtaVi == null ? {} : { deliveryEtaVi: extra.deliveryEtaVi }),
        ...(extra.warrantyVi == null ? {} : { warrantyVi: extra.warrantyVi }),
        ...(extra.supportVi == null ? {} : { supportVi: extra.supportVi }),
        ...(extra.termsVi == null ? {} : { termsVi: extra.termsVi }),
        ...(extra.tags == null ? {} : { tags: extra.tags }),
        ...(extra.deliveryConfig == null ? {} : { deliveryConfig: extra.deliveryConfig }),
        ...(row.fulfillment_type == null ? {} : { fulfillmentType: row.fulfillment_type }),
        inventoryFields: Array.isArray(row.inventory_fields)
          ? (row.inventory_fields as InventoryField[])
          : [],
        ...(row.low_stock_threshold == null ? {} : { lowStockThreshold: row.low_stock_threshold }),
        ...(row.service_instructions == null
          ? {}
          : { serviceInstructions: row.service_instructions }),
        ...(row.initial_quantity == null ? {} : { initialQuantity: row.initial_quantity }),
        ...(fileArtifactFromStored(row.file_artifact) === null
          ? {}
          : { fileArtifact: fileArtifactFromStored(row.file_artifact)! }),
        ...(supplierConfigFromStored(row.supplier_config) === null
          ? {}
          : { supplierConfig: supplierConfigFromStored(row.supplier_config)! }),
        expiresAt: row.expires_at.getTime(),
      };
    },
    async remove(adminTelegramUserId) {
      await sql`delete from admin_workflow where admin_telegram_user_id = ${adminTelegramUserId}`.execute(
        db,
      );
    },
  };
}

export interface DurableProductDraftWorkflow {
  start(adminTelegramUserId: string, now?: number): Promise<ProductDraft>;
  startVariant(adminTelegramUserId: string, productId: string, now?: number): Promise<ProductDraft>;
  advance(adminTelegramUserId: string, value: string, now?: number): Promise<DraftResult>;
  get(adminTelegramUserId: string, now?: number): Promise<ProductDraft | null>;
  cancel(adminTelegramUserId: string): Promise<void>;
}

export function createDurableProductDraftWorkflow(
  repository: ProductDraftRepository,
): DurableProductDraftWorkflow {
  return {
    async start(adminTelegramUserId, now) {
      const draft = startProductDraft(adminTelegramUserId, now);
      await repository.save(draft);
      return draft;
    },
    async startVariant(adminTelegramUserId, productId, now) {
      const draft = startProductVariantDraft(adminTelegramUserId, productId, now);
      await repository.save(draft);
      return draft;
    },
    async advance(adminTelegramUserId, value, now) {
      const draft = await repository.load(adminTelegramUserId);
      if (!draft)
        return { ok: false, error: "NO_DRAFT", draft: startProductDraft(adminTelegramUserId, now) };
      const result = advanceProductDraft(draft, value, now);
      if (result.ok) await repository.save(result.draft);
      return result;
    },
    async get(adminTelegramUserId, now = Date.now()) {
      const draft = await repository.load(adminTelegramUserId);
      if (!draft || draft.expiresAt <= now) {
        if (draft) await repository.remove(adminTelegramUserId);
        return null;
      }
      return draft;
    },
    cancel: (adminTelegramUserId) => repository.remove(adminTelegramUserId),
  };
}

export function createProductDraftWorkflow(): ProductDraftWorkflow {
  const drafts = new Map<string, ProductDraft>();
  return {
    start(adminTelegramUserId, now) {
      const draft = startProductDraft(adminTelegramUserId, now);
      drafts.set(adminTelegramUserId, draft);
      return draft;
    },
    startVariant(adminTelegramUserId, productId, now) {
      const draft = startProductVariantDraft(adminTelegramUserId, productId, now);
      drafts.set(adminTelegramUserId, draft);
      return draft;
    },
    advance(adminTelegramUserId, value, now) {
      const draft = drafts.get(adminTelegramUserId);
      if (!draft)
        return { ok: false, error: "NO_DRAFT", draft: startProductDraft(adminTelegramUserId, now) };
      const result = advanceProductDraft(draft, value, now);
      if (result.ok) drafts.set(adminTelegramUserId, result.draft);
      return result;
    },
    get(adminTelegramUserId, now = Date.now()) {
      const draft = drafts.get(adminTelegramUserId);
      if (!draft || draft.expiresAt <= now) {
        drafts.delete(adminTelegramUserId);
        return null;
      }
      return draft;
    },
    cancel(adminTelegramUserId) {
      drafts.delete(adminTelegramUserId);
    },
  };
}
