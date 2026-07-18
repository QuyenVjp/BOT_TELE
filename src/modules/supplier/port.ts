import { z } from "zod";
import { AppError } from "../../shared/errors/index.js";

/**
 * Supplier Port types + allowlisted response schemas (FR-015/FR-016,
 * contracts/supplier-port.md).
 *
 * Every supplier response is UNTRUSTED and schema-validated before it can touch
 * the domain. The adapter maps supplier-specific values into these canonical
 * results; domain modules never import an SDK. Secret material only ever crosses
 * this boundary as a `vault:` reference — the schema rejects a free-form secret
 * body, so a raw credential can never be smuggled into an asset envelope.
 *
 * Transport timeout after submission maps to `UNKNOWN` (never `REJECTED`, never
 * auto-retry). A HTTP-success without a complete valid `assetEnvelope` is a
 * review case, never a silent delivery.
 */

export class SupplierPortError extends AppError {
  /** Supplier-specific reason code (SCHEMA_INVALID, TIMEOUT, …). */
  readonly supplierCode: string;

  constructor(supplierCode: string, message: string) {
    // AppError code is the closed set; supplierCode carries the detail.
    // Message is deliberately generic — never echoes a raw response/secret.
    super("SUPPLIER", message, { supplierCode });
    this.name = "SupplierPortError";
    this.supplierCode = supplierCode;
  }
}

const DeliveryTypeEnum = z.enum([
  "INVITE",
  "LICENSE",
  "ACTIVATION_KEY",
  "CREDENTIAL",
  "MANUAL_REVIEW",
]);

/**
 * Canonical validated asset envelope. `.strict()` rejects any extra key (e.g. a
 * smuggled `secret`/`password` field), and `vaultRef` must be an opaque vault
 * reference — the plaintext never lives here.
 */
export const AssetEnvelopeSchema = z
  .object({
    deliveryType: DeliveryTypeEnum,
    expectedSku: z.string().min(1).max(120),
    region: z.string().min(1).max(16).nullable(),
    durationCode: z.string().min(1).max(16),
    expiresAt: z.string().datetime().nullable(),
    supplierAssetId: z.string().min(1).max(120),
    fingerprint: z.string().min(1).max(200),
    vaultRef: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("vault:"), {
        message: "asset secret must be a vault reference",
      }),
  })
  .strict();

export type AssetEnvelope = z.infer<typeof AssetEnvelopeSchema>;

/** createOrder result (discriminated union on `kind`). */
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

/** queryOrder / reconcile observation. */
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

export type AvailabilityStatus = "AVAILABLE" | "LOW" | "OUT" | "UNKNOWN";

/** Parse helpers — throw {@link SupplierPortError} on schema failure. */
export function parseAssetEnvelope(input: unknown): AssetEnvelope {
  const parsed = AssetEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplierPortError("SCHEMA_INVALID", "asset envelope failed schema validation");
  }
  return parsed.data;
}

export function parseCreateOrderResult(input: unknown): CreateOrderResult {
  const parsed = CreateOrderResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplierPortError("SCHEMA_INVALID", "create result failed schema validation");
  }
  return parsed.data;
}

export function parseQueryOrderResult(input: unknown): QueryOrderResult {
  const parsed = QueryOrderResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupplierPortError("SCHEMA_INVALID", "query result failed schema validation");
  }
  return parsed.data;
}

export interface CreateOrderInput {
  /** Stable idempotency key — create retries reuse it verbatim. */
  idempotencyKey: string;
  supplierSku: string;
  /** Expected cost ceiling in integer VND. */
  costCeilingVnd: number;
  /** Internal Order reference (never a secret). */
  orderId: string;
  region?: string;
}

export interface QueryOrderInput {
  externalOrderId?: string;
  queryKey?: string;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  observedAt: string;
  supplierReference?: string | undefined;
  quantity?: number | undefined;
}

export interface SupplierActionInput {
  externalOrderId: string;
  idempotencyKey: string;
  reason: string;
}

export type SupplierActionResult = {
  status: "ACCEPTED" | "PENDING" | "FINAL" | "UNSUPPORTED";
};

export interface ReconcileInput {
  cursor?: string;
  since?: string;
  limit: number;
}

export interface ReconcileResult {
  observations: QueryOrderResult[];
  nextCursor: string | null;
}

/**
 * Canonical supplier port. Every adapter validates its transport responses
 * through the schemas above before returning these types.
 */
export interface SupplierPort {
  getAvailability(input: { supplierSku: string; region?: string }): Promise<AvailabilityResult>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  queryOrder(input: QueryOrderInput): Promise<QueryOrderResult>;
  cancelOrder(input: SupplierActionInput): Promise<SupplierActionResult>;
  requestRefund(input: SupplierActionInput): Promise<SupplierActionResult>;
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
}
