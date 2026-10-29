import { z } from "zod";
import { AppError } from "../../shared/errors/index.js";

/**
 * Canonical supplier contracts. Provider responses are untrusted and must be
 * parsed before any value is used for routing, stock, or purchase decisions.
 */

export const SUPPLIER_CAPABILITIES = [
  "HEALTH_READ",
  "CATALOG_LIST",
  "CATALOG_DETAIL",
  "BALANCE_READ",
  "ORDER_CREATE",
  "ORDER_READ",
  "ORDER_LIST",
  "NATIVE_IDEMPOTENCY",
  "CANCEL",
  "REFUND",
  "STOCK_QUANTITY",
  "DELIVERY_PAYLOAD",
  "RATE_LIMIT_RETRY_AFTER",
] as const;
export type SupplierCapability = (typeof SUPPLIER_CAPABILITIES)[number];

export type SupplierProductSupportStatus = "SUPPORTED" | "UNSUPPORTED";
export const SUPPLIER_PRODUCT_UNSUPPORTED_REASONS = [
  "CUSTOMER_INPUT_COUNT_INCONSISTENT",
  "CUSTOMER_INPUT_UNSUPPORTED",
  "MAX_QUANTITY_SEMANTICS_UNKNOWN",
  "QUANTITY_BOUNDS_INCONSISTENT",
  "FIXED_QUANTITY_UNSUPPORTED",
  "QUANTITY_UNSUPPORTED",
] as const;
export type SupplierProductUnsupportedReason =
  (typeof SUPPLIER_PRODUCT_UNSUPPORTED_REASONS)[number];

export const AvailabilityStatusSchema = z.enum(["AVAILABLE", "LOW", "OUT", "UNKNOWN"]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

const StoredIntegerSchema = z.number().finite().int().refine(Number.isSafeInteger);
const CanonicalIdentifierSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value));
const NullableTextSchema = z.string().max(8_000).nullable();
const MetadataValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/**
 * Runtime contract for normalized supplier catalog data.
 *
 * Product and variant IDs are opaque and case-preserving; values must be nonempty, trimmed,
 * and control-free. Cost is an integer VND amount. Unknown or non-unit purchase quantity
 * semantics are UNSUPPORTED, not guessed. Availability and stockQuantity are provider facts,
 * never local stock, reservation, or ledger evidence.
 */
export const NormalizedSupplierProductSchema = z
  .object({
    providerKey: CanonicalIdentifierSchema(120),
    externalProductId: CanonicalIdentifierSchema(200),
    externalVariantId: CanonicalIdentifierSchema(200).nullable(),
    nameVi: z.string().min(1).max(8_000),
    nameEn: NullableTextSchema,
    descriptionVi: NullableTextSchema,
    descriptionEn: NullableTextSchema,
    warrantyVi: NullableTextSchema,
    warrantyEn: NullableTextSchema,
    customerInputType: z.string().max(120).nullable(),
    requiresCustomerInput: z.boolean(),
    customerInputsPerItem: StoredIntegerSchema,
    customerPromptVi: NullableTextSchema,
    customerPromptEn: NullableTextSchema,
    fulfillmentMode: z.string().max(120).nullable(),
    availability: AvailabilityStatusSchema,
    stockType: z.string().max(120).nullable(),
    stockQuantity: StoredIntegerSchema.nullable(),
    minQuantity: StoredIntegerSchema,
    maxQuantity: StoredIntegerSchema.nullable(),
    fixedQuantity: StoredIntegerSchema.nullable(),
    costVnd: StoredIntegerSchema,
    currency: z.literal("VND"),
    pricingSource: z.string().max(120).nullable(),
    upstreamUpdatedAt: z.string().max(512).nullable(),
    supportStatus: z.enum(["SUPPORTED", "UNSUPPORTED"]),
    unsupportedReason: z.enum(SUPPLIER_PRODUCT_UNSUPPORTED_REASONS).nullable(),
    metadataSafe: z.record(z.string().max(128), MetadataValueSchema),
  })
  .strict();

export type NormalizedSupplierProduct = z.infer<typeof NormalizedSupplierProductSchema>;

function assertProductSemantics(product: NormalizedSupplierProduct): void {
  const storedInteger = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
  if (
    !storedInteger(product.costVnd) ||
    !storedInteger(product.customerInputsPerItem) ||
    !storedInteger(product.minQuantity) ||
    product.minQuantity < 1 ||
    (product.stockQuantity !== null && !storedInteger(product.stockQuantity)) ||
    (product.maxQuantity !== null && !storedInteger(product.maxQuantity)) ||
    (product.fixedQuantity !== null && !storedInteger(product.fixedQuantity))
  ) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  if (
    product.upstreamUpdatedAt !== null &&
    !Number.isFinite(Date.parse(product.upstreamUpdatedAt))
  ) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  if (product.supportStatus === "SUPPORTED" && product.unsupportedReason !== null) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  if (product.supportStatus === "UNSUPPORTED" && product.unsupportedReason === null) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  if (
    product.supportStatus === "SUPPORTED" &&
    (product.requiresCustomerInput ||
      product.customerInputsPerItem > 0 ||
      product.minQuantity > 1 ||
      (product.fixedQuantity !== null && product.fixedQuantity !== 1))
  ) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  const inconsistentBounds =
    product.maxQuantity !== null && product.maxQuantity < product.minQuantity;
  if (
    inconsistentBounds &&
    (product.supportStatus === "SUPPORTED" ||
      product.unsupportedReason !== "QUANTITY_BOUNDS_INCONSISTENT")
  ) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
  if (product.fixedQuantity !== null && product.fixedQuantity < 1) {
    throw new Error("SUPPLIER_PRODUCT_INVALID");
  }
}

/** Validate unknown provider catalog data before it can influence curation. */
export function assertNormalizedSupplierProduct(
  input: unknown,
): asserts input is NormalizedSupplierProduct {
  const parsed = NormalizedSupplierProductSchema.safeParse(input);
  if (!parsed.success) throw new Error("SUPPLIER_PRODUCT_INVALID");
  assertProductSemantics(parsed.data);
}

export function parseNormalizedSupplierProduct(input: unknown): NormalizedSupplierProduct {
  assertNormalizedSupplierProduct(input);
  return input;
}

export interface NormalizedSupplierBalance {
  available: number;
  currency: string;
}
export const NormalizedSupplierBalanceSchema = z
  .object({
    available: z.number().finite().refine(Number.isSafeInteger).min(0),
    currency: z.string().min(1).max(16),
  })
  .strict();

export interface NormalizedSupplierHealth {
  ready: boolean;
  service: string | null;
}
export const NormalizedSupplierHealthSchema = z
  .object({ ready: z.boolean(), service: z.string().max(200).nullable() })
  .strict();

export class SupplierPortError extends AppError {
  readonly supplierCode: string;
  readonly retryAfterSeconds: number | null;

  constructor(supplierCode: string, message: string, retryAfterSeconds: number | null = null) {
    super("SUPPLIER", message, { supplierCode });
    this.name = "SupplierPortError";
    this.supplierCode = supplierCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const DeliveryTypeEnum = z.enum([
  "INVITE",
  "LICENSE",
  "ACTIVATION_KEY",
  "CREDENTIAL",
  "MANUAL_REVIEW",
]);

export const AssetEnvelopeSchema = z
  .object({
    deliveryType: DeliveryTypeEnum,
    expectedSku: z.string().min(1).max(120),
    region: z.string().min(1).max(16).nullable(),
    durationCode: z.string().min(1).max(16),
    expiresAt: z.string().datetime().nullable(),
    supplierAssetId: z.string().min(1).max(120),
    fingerprint: z.string().min(1).max(200),
    vaultRef: z.string().regex(/^vault:\S{1,512}$/u, {
      message: "asset secret must be a vault reference",
    }),
  })
  .strict();
export type AssetEnvelope = z.infer<typeof AssetEnvelopeSchema>;

export const CreateOrderResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ACCEPTED"),
      externalOrderId: z.string().min(1),
      status: z.enum(["PENDING", "SUBMITTED"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("FULFILLED"),
      externalOrderId: z.string().min(1),
      assetEnvelope: AssetEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("REJECTED"),
      code: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("UNKNOWN"),
      queryKey: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type CreateOrderResult = z.infer<typeof CreateOrderResultSchema>;

export const QueryOrderResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PENDING"), externalOrderId: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal("FULFILLED"),
      externalOrderId: z.string().min(1),
      assetEnvelope: AssetEnvelopeSchema,
    })
    .strict(),
  z.object({ status: z.literal("REJECTED"), externalOrderId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("CANCELLED"), externalOrderId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("REFUNDED"), externalOrderId: z.string().min(1) }).strict(),
]);
export type QueryOrderResult = z.infer<typeof QueryOrderResultSchema>;

export const AvailabilityResultSchema = z
  .object({
    status: AvailabilityStatusSchema,
    observedAt: z.string().datetime(),
    supplierReference: z.string().min(1).max(200).optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantity === 0 && (value.status === "AVAILABLE" || value.status === "LOW")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "zero quantity cannot be reported as available",
      });
    }
  });
export type AvailabilityResult = z.infer<typeof AvailabilityResultSchema>;

export const SupplierActionResultSchema = z
  .object({ status: z.enum(["ACCEPTED", "PENDING", "FINAL", "UNSUPPORTED"]) })
  .strict();
export type SupplierActionResult = z.infer<typeof SupplierActionResultSchema>;

export const ReconcileResultSchema = z
  .object({
    observations: z.array(z.unknown()).max(100),
    nextCursor: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type ReconcileResultWire = z.infer<typeof ReconcileResultSchema>;

export function parseAssetEnvelope(input: unknown): AssetEnvelope {
  const parsed = AssetEnvelopeSchema.safeParse(input);
  if (!parsed.success)
    throw new SupplierPortError("SCHEMA_INVALID", "asset envelope failed schema validation");
  return parsed.data;
}

export function parseCreateOrderResult(input: unknown): CreateOrderResult {
  const parsed = CreateOrderResultSchema.safeParse(input);
  if (!parsed.success)
    throw new SupplierPortError("SCHEMA_INVALID", "create result failed schema validation");
  return parsed.data;
}

export function parseQueryOrderResult(input: unknown): QueryOrderResult {
  const parsed = QueryOrderResultSchema.safeParse(input);
  if (!parsed.success)
    throw new SupplierPortError("SCHEMA_INVALID", "query result failed schema validation");
  return parsed.data;
}

export function parseAvailabilityResult(input: unknown): AvailabilityResult {
  const parsed = AvailabilityResultSchema.safeParse(input);
  if (!parsed.success)
    throw new SupplierPortError("SCHEMA_INVALID", "availability result failed schema validation");
  return parsed.data;
}

export function parseSupplierActionResult(input: unknown): SupplierActionResult {
  const parsed = SupplierActionResultSchema.safeParse(input);
  if (!parsed.success)
    throw new SupplierPortError(
      "SCHEMA_INVALID",
      "supplier action result failed schema validation",
    );
  return parsed.data;
}

export interface CreateOrderInput {
  idempotencyKey: string;
  supplierSku: string;
  costCeilingVnd: number;
  orderId: string;
  region?: string;
}

export interface QueryOrderInput {
  expectedSku?: string;
  externalOrderId?: string;
  queryKey?: string;
}

export interface SupplierActionInput {
  externalOrderId: string;
  idempotencyKey: string;
  reason: string;
}

export interface ReconcileInput {
  cursor?: string;
  since?: string;
  limit: number;
}

export interface ReconcileResult {
  observations: QueryOrderResult[];
  nextCursor: string | null;
}

export interface SupplierPort {
  getAvailability(input: { supplierSku: string; region?: string }): Promise<AvailabilityResult>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  queryOrder(input: QueryOrderInput): Promise<QueryOrderResult>;
  cancelOrder(input: SupplierActionInput): Promise<SupplierActionResult>;
  requestRefund(input: SupplierActionInput): Promise<SupplierActionResult>;
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
}

export interface SupplierProvider extends SupplierPort {
  readonly providerKey: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<SupplierCapability>;
  readonly listProducts?: () => Promise<readonly NormalizedSupplierProduct[]>;
  readonly getProduct?: (externalProductId: string) => Promise<NormalizedSupplierProduct>;
  readonly getBalance?: () => Promise<NormalizedSupplierBalance>;
  readonly health?: () => Promise<NormalizedSupplierHealth>;
}

export function isSupplierProviderFor(
  provider: SupplierPort | SupplierProvider,
  supplierId: string,
): boolean {
  return (
    supplierId.trim().length > 0 &&
    "providerKey" in provider &&
    typeof provider.providerKey === "string" &&
    provider.providerKey === supplierId
  );
}

export function hasSupplierCapability(
  provider: Pick<SupplierProvider, "capabilities">,
  capability: SupplierCapability,
): boolean {
  return provider.capabilities.has(capability);
}
