import { sql, type Kysely } from "kysely";
import type { Database } from "../../infrastructure/db/client.js";
import { type FulfillmentType, type InventoryField } from "./fulfillment-type.js";

export type ProductDraftStep =
  | "name"
  | "sku"
  | "variantName"
  | "price"
  | "category"
  | "fulfillmentType"
  | "serviceInstructions"
  | "initialQuantity"
  | "fileArtifact"
  | "supplierConfig"
  | "inventoryFields"
  | "threshold"
  | "confirm";

export interface ProductDraft {
  adminTelegramUserId: string;
  step: ProductDraftStep;
  name?: string;
  slug?: string;
  sku?: string;
  categoryId?: string;
  existingProductId?: string;
  priceVnd?: bigint;
  description?: string;
  lowStockThreshold?: number;
  variantName?: string;
  fulfillmentType?: FulfillmentType;
  inventoryFields?: InventoryField[];
  serviceInstructions?: string;
  initialQuantity?: number;
  fileArtifact?: {
    filename: string;
    mimeType: string;
    sizeBytes: bigint;
    sha256: string;
    storageReference: string;
  };
  supplierConfig?: {
    supplierId: string;
    externalSku: string;
    costVnd: bigint;
    region?: string;
  };
  expiresAt: number;
}

export type ProductDraftFileArtifact = NonNullable<ProductDraft["fileArtifact"]>;
export type ProductDraftSupplierConfig = NonNullable<ProductDraft["supplierConfig"]>;

function fileArtifactFromStored(value: unknown): ProductDraftFileArtifact | null {
  if (value === null || typeof value !== "object") return null;
  const { filename, mimeType, sizeBytes, sha256, storageReference } = value as Record<
    string,
    unknown
  >;
  if (
    typeof filename !== "string" ||
    typeof mimeType !== "string" ||
    typeof sha256 !== "string" ||
    typeof storageReference !== "string"
  )
    return null;
  if (typeof sizeBytes !== "string" && typeof sizeBytes !== "number") return null;
  return { filename, mimeType, sizeBytes: BigInt(sizeBytes), sha256, storageReference };
}

function supplierConfigFromStored(value: unknown): ProductDraftSupplierConfig | null {
  if (value === null || typeof value !== "object") return null;
  const { supplierId, externalSku, costVnd, region } = value as Record<string, unknown>;
  if (typeof supplierId !== "string" || typeof externalSku !== "string") return null;
  if (typeof costVnd !== "string" && typeof costVnd !== "number") return null;
  if (region !== undefined && typeof region !== "string") return null;
  return { supplierId, externalSku, costVnd: BigInt(costVnd), ...(region ? { region } : {}) };
}

const TTL_MS = 15 * 60_000;
export const SKU = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function generateProductSlug(name: string, sku: string): string {
  const base = (name || sku || "product")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length >= 2 ? base.slice(0, 100) : `${base || "p"}-prod`.slice(0, 100);
}

export function generateSkuProposal(name: string): string {
  const base = (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = base.length > 0 ? base.slice(0, 24) : "SP";
  return `${prefix}-001`;
}
const INVENTORY_FIELD_PRESETS = {
  STOCK_ACCOUNT: {
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
    email: { name: "email", label: "Email", required: false, secret: false, customerVisible: true },
    profile_url: {
      name: "profile_url",
      label: "Liên kết hồ sơ",
      required: false,
      secret: false,
      customerVisible: true,
    },
    note: {
      name: "note",
      label: "Ghi chú",
      required: false,
      secret: false,
      customerVisible: false,
    },
  },
} satisfies Record<"STOCK_ACCOUNT", Record<string, InventoryField>>;

const CODE_FIELDS: InventoryField[] = [
  { name: "code", label: "Mã kích hoạt", required: true, secret: true, customerVisible: true },
];

function parseInventoryFields(text: string): InventoryField[] {
  const names = text
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0)
    return [
      INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT.username,
      INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT.password,
    ];
  const fields: InventoryField[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const field =
      INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT[
        name as keyof typeof INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT
      ];
    if (!field || seen.has(field.name)) continue;
    fields.push(field);
    seen.add(field.name);
  }
  return fields.length
    ? fields
    : [
        INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT.username,
        INVENTORY_FIELD_PRESETS.STOCK_ACCOUNT.password,
      ];
}

function parseSupplierConfig(text: string): ProductDraft["supplierConfig"] | null {
  const [supplierId, externalSku, costVnd, region] = text.split("|").map((part) => part.trim());
  if (!supplierId || !externalSku || !costVnd || !/^\d+$/.test(costVnd)) return null;
  return { supplierId, externalSku, costVnd: BigInt(costVnd), ...(region ? { region } : {}) };
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
  if (!text || text.length > 2_000) return { ok: false, error: "INVALID_VALUE", draft };
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
      next.step = "variantName";
      break;
    case "variantName":
      next.variantName = text;
      next.step = "price";
      break;
    case "price": {
      const normalized = text.replace(/[.,]/g, "");
      if (!/^\d+$/.test(normalized)) return { ok: false, error: "INVALID_PRICE", draft };
      next.priceVnd = BigInt(normalized);
      next.step = draft.existingProductId ? "fulfillmentType" : "category";
      break;
    }
    case "category":
      next.categoryId = text;
      next.step = "fulfillmentType";
      break;
    case "fulfillmentType": {
      const fulfillmentType = text.toUpperCase() as FulfillmentType;
      if (
        ![
          "STOCK_ACCOUNT",
          "STOCK_CODE",
          "DIGITAL_FILE",
          "SUPPLIER_API",
          "MANUAL_FULFILLMENT",
          "UNLIMITED_SERVICE",
          "QUANTITY_STOCK",
        ].includes(fulfillmentType)
      )
        return { ok: false, error: "UNSUPPORTED_FULFILLMENT_TYPE", draft };
      next.fulfillmentType = fulfillmentType;
      if (fulfillmentType === "STOCK_CODE") {
        next.inventoryFields = CODE_FIELDS;
        next.step = "threshold";
      } else if (fulfillmentType === "STOCK_ACCOUNT") {
        next.step = "inventoryFields";
      } else if (fulfillmentType === "DIGITAL_FILE") {
        next.inventoryFields = [];
        next.lowStockThreshold = 0;
        next.step = "confirm";
      } else {
        next.inventoryFields = [];
        next.lowStockThreshold = 0;
        next.step = fulfillmentType === "SUPPLIER_API" ? "supplierConfig" : "serviceInstructions";
      }
      break;
    }
    case "supplierConfig": {
      const supplierConfig = parseSupplierConfig(text);
      if (!supplierConfig) return { ok: false, error: "INVALID_SUPPLIER_CONFIG", draft };
      next.supplierConfig = supplierConfig;
      next.step = "confirm";
      break;
    }
    case "serviceInstructions":
      next.serviceInstructions = text;
      next.step = draft.fulfillmentType === "QUANTITY_STOCK" ? "initialQuantity" : "confirm";
      break;
    case "initialQuantity":
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0)
        return { ok: false, error: "INVALID_QUANTITY", draft };
      next.initialQuantity = Number(text);
      next.step = "threshold";
      break;
    case "inventoryFields":
      next.inventoryFields = parseInventoryFields(text);
      next.step = "threshold";
      break;
    case "threshold":
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
        return { ok: false, error: "INVALID_THRESHOLD", draft };
      next.lowStockThreshold = Number(text);
      next.step = "confirm";
      break;
    case "confirm":
      return { ok: false, error: "DRAFT_READY", draft };
  }
  return { ok: true, draft: next };
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
};

export function createProductDraftRepository(db: Kysely<Database>): ProductDraftRepository {
  return {
    async save(draft) {
      await sql`
        insert into admin_workflow
          (admin_telegram_user_id, step, name, slug, sku, category_id, existing_product_id, variant_name, price_vnd,
           description, fulfillment_type, inventory_fields, low_stock_threshold, service_instructions,
           initial_quantity, file_artifact, supplier_config, expires_at)
        values (${draft.adminTelegramUserId}, ${draft.step}, ${draft.name ?? null},
          ${draft.slug ?? null}, ${draft.sku ?? null}, ${draft.categoryId ?? null}, ${draft.existingProductId ?? null}, ${draft.variantName ?? null},
          ${draft.priceVnd?.toString() ?? null}, ${draft.description ?? null}, ${draft.fulfillmentType ?? null},
          ${JSON.stringify(draft.inventoryFields ?? [])}::jsonb, ${draft.lowStockThreshold ?? null},
          ${draft.serviceInstructions ?? null}, ${draft.initialQuantity ?? null}, ${JSON.stringify(draft.fileArtifact ? { ...draft.fileArtifact, sizeBytes: draft.fileArtifact.sizeBytes.toString() } : null)}::jsonb, ${JSON.stringify(draft.supplierConfig ? { ...draft.supplierConfig, costVnd: draft.supplierConfig.costVnd.toString() } : null)}::jsonb, to_timestamp(${draft.expiresAt} / 1000.0))
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
          expires_at = excluded.expires_at, updated_at = now()
      `.execute(db);
    },
    async load(adminTelegramUserId) {
      const result = await sql<DraftRow>`select * from admin_workflow
        where admin_telegram_user_id = ${adminTelegramUserId}`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      return {
        adminTelegramUserId: row.admin_telegram_user_id,
        step: row.step,
        ...(row.name == null ? {} : { name: row.name }),
        ...(row.slug == null ? {} : { slug: row.slug }),
        ...(row.sku == null ? {} : { sku: row.sku }),
        ...(row.category_id == null ? {} : { categoryId: row.category_id }),
        ...(row.existing_product_id == null ? {} : { existingProductId: row.existing_product_id }),
        ...(row.variant_name == null ? {} : { variantName: row.variant_name }),
        ...(row.price_vnd == null ? {} : { priceVnd: BigInt(row.price_vnd) }),
        ...(row.description == null ? {} : { description: row.description }),
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
