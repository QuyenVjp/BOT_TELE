import { z } from "zod";
import { OutboundPolicyError } from "../../../infrastructure/net/outbound-policy.js";
import { createPinnedFetch } from "../../../infrastructure/net/pinned-fetch.js";
import type { Vault } from "../../../infrastructure/vault/port.js";
import {
  SupplierPortError,
  type AvailabilityResult,
  type CreateOrderInput,
  type CreateOrderResult,
  type NormalizedSupplierProduct,
  type QueryOrderInput,
  type QueryOrderResult,
  type ReconcileInput,
  type ReconcileResult,
  type SupplierActionInput,
  type SupplierActionResult,
  type SupplierCapability,
  type SupplierProvider,
} from "../port.js";

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_TEXT = 8_000;

const Text = z.string().min(1).max(MAX_TEXT);
const NullableText = z.string().max(MAX_TEXT).nullable().optional();

export const QcstProductSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: Text,
    name_en: Text,
    description: z.string().max(MAX_TEXT),
    description_en: z.string().max(MAX_TEXT),
    warranty: z.string().max(MAX_TEXT),
    warranty_en: z.string().max(MAX_TEXT),
    customer_input_type: z.string().min(1).max(64),
    requires_customer_input: z.boolean(),
    customer_inputs_per_item: z.number().int().min(1).max(100),
    customer_prompt: z.string().max(MAX_TEXT),
    customer_prompt_en: z.string().max(MAX_TEXT),
    fulfillment_mode: z.string().min(1).max(64),
    availability: z.string().min(1).max(64),
    stock_type: z.string().min(1).max(64),
    stock_quantity: z.number().int().min(0).nullable().optional(),
    min_quantity: z.number().int().min(1).max(50).default(1),
    max_quantity: z.number().int().min(1).max(50).nullable().optional(),
    fixed_quantity: z.number().int().min(1).max(50).nullable().optional(),
    price: z.number().int().min(0),
    pricing_source: z.string().min(1).max(64).default("BASE"),
    currency: z.string().min(1).max(16),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strip();

export type QcstProduct = z.infer<typeof QcstProductSchema>;

function normalizeAvailability(value: string): AvailabilityResult["status"] {
  const normalized = value.trim().toUpperCase();
  if (normalized === "AVAILABLE") return "AVAILABLE";
  if (normalized === "LOW") return "LOW";
  if (normalized === "OUT" || normalized === "OUT_OF_STOCK" || normalized === "UNAVAILABLE") {
    return "OUT";
  }
  return "UNKNOWN";
}

export function normalizeQcstProduct(product: QcstProduct): NormalizedSupplierProduct {
  return {
    providerKey: "qcst",
    externalProductId: product.id,
    externalVariantId: null,
    nameVi: product.name,
    nameEn: product.name_en,
    descriptionVi: product.description,
    descriptionEn: product.description_en,
    warrantyVi: product.warranty,
    warrantyEn: product.warranty_en,
    customerInputType: product.customer_input_type,
    requiresCustomerInput: product.requires_customer_input,
    customerInputsPerItem: product.customer_inputs_per_item,
    customerPromptVi: product.customer_prompt,
    customerPromptEn: product.customer_prompt_en,
    fulfillmentMode: product.fulfillment_mode,
    availability: normalizeAvailability(product.availability),
    stockType: product.stock_type,
    stockQuantity: product.stock_quantity ?? null,
    minQuantity: product.min_quantity,
    maxQuantity: product.max_quantity ?? null,
    fixedQuantity: product.fixed_quantity ?? null,
    costVnd: product.price,
    currency: product.currency,
    pricingSource: product.pricing_source,
    upstreamUpdatedAt: product.updated_at,
    metadataSafe: { pricingSource: product.pricing_source },
  };
}

const QcstBalanceSchema = z
  .object({ available: z.number().int(), currency: z.string().min(1).max(16) })
  .strip();
export type QcstBalance = z.infer<typeof QcstBalanceSchema>;

const QcstErrorSchema = z
  .object({ code: z.string().min(1).max(128), detail: z.string().min(1).max(MAX_TEXT) })
  .strip();

export const QcstOrderSchema = z
  .object({
    id: z.string().min(1).max(128),
    client_order_id: z.string().min(1).max(128),
    product_id: z.string().min(1).max(128),
    quantity: z.number().int().min(1).max(50),
    unit_price: z.number().int().min(0),
    total_amount: z.number().int().min(0),
    currency: z.string().min(1).max(16),
    status: z.string().min(1).max(64),
    payment_status: z.string().min(1).max(64),
    cancellable: z.boolean(),
    delivery_available: z.boolean(),
    delivery: z.unknown().nullable().optional(),
    delivery_expires_at: NullableText,
    error: QcstErrorSchema.nullable().optional(),
    status_url: z.string().max(2_048),
    poll_after_seconds: z.number().int().min(0).max(86_400),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strip();
export type QcstOrder = z.infer<typeof QcstOrderSchema>;

const ProductListResponseSchema = z
  .object({ success: z.literal(true), data: z.array(QcstProductSchema).max(10_000) })
  .strip();
const ProductResponseSchema = z
  .object({ success: z.literal(true), data: QcstProductSchema })
  .strip();
const BalanceResponseSchema = z
  .object({ success: z.literal(true), data: QcstBalanceSchema })
  .strip();
const OrderResponseSchema = z.object({ success: z.literal(true), data: QcstOrderSchema }).strip();
const OrderListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(QcstOrderSchema).max(100),
        has_more: z.boolean(),
        next_cursor: z.string().max(128).nullable(),
      })
      .strip(),
  })
  .strip();
const CancelOrderResponseSchema = z
  .object({
    success: z.literal(true),
    data: QcstOrderSchema,
    idempotency_replayed: z.boolean(),
  })
  .strip();

export interface QcstSupplierOptions {
  baseUrl: string;
  apiKeyVaultRef: string;
  vault: Vault;
  timeoutMs: number;
  testTransport?: {
    allowInsecureLoopback?: boolean;
    fetch?: typeof fetch;
    resolve?: (hostname: string) => Promise<readonly string[]>;
  };
}

export interface QcstCatalogPort {
  listProducts(): Promise<readonly NormalizedSupplierProduct[]>;
  getBalance(): Promise<QcstBalance>;
}

class QcstHttpError extends SupplierPortError {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null) {
    super(`HTTP_${status}`, "QCST request was refused");
    this.name = "QcstHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function validateOptions(options: QcstSupplierOptions): URL {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new SupplierPortError("CONFIG_INVALID", "QCST configuration is invalid");
  }
  const loopbackTest =
    options.testTransport?.allowInsecureLoopback === true &&
    base.protocol === "http:" &&
    (base.hostname === "127.0.0.1" || base.hostname === "localhost");
  if (
    (base.protocol !== "https:" && !loopbackTest) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    (base.protocol === "https:" &&
      (base.hostname !== "api.qcst.tech" || (base.port && base.port !== "443"))) ||
    !options.apiKeyVaultRef.startsWith("vault:") ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 30_000
  ) {
    throw new SupplierPortError("CONFIG_INVALID", "QCST configuration is invalid");
  }
  return base;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds, 86_400);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(86_400, Math.max(0, Math.ceil((at - Date.now()) / 1_000)));
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierPortError("CONTENT_TYPE_INVALID", "QCST response is invalid");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SupplierPortError("RESPONSE_INVALID", "QCST response is invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new SupplierPortError("RESPONSE_TOO_LARGE", "QCST response is invalid");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) {
      throw new SupplierPortError("TRANSPORT_TIMEOUT", "QCST request timed out");
    }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SupplierPortError("RESPONSE_INVALID", "QCST response is invalid");
  }
}

function responseError(status: number, retryAfter: number | null): QcstHttpError {
  return new QcstHttpError(status, retryAfter);
}

function isTransportError(error: unknown): boolean {
  return (
    error instanceof SupplierPortError &&
    ["TRANSPORT_TIMEOUT", "TRANSPORT_ERROR", "DNS_RESOLUTION_FAILED"].includes(error.supplierCode)
  );
}

function hasUnsupportedDelivery(order: QcstOrder): boolean {
  return order.delivery_available || (order.delivery !== undefined && order.delivery !== null);
}

function mapOrderToQuery(order: QcstOrder): QueryOrderResult {
  const externalOrderId = order.id;
  const status = order.status.trim().toUpperCase();
  if (["FAILED", "REJECTED", "CANCELLED", "REFUNDED", "REFUND_FAILED"].includes(status)) {
    if (status === "CANCELLED") return { status: "CANCELLED", externalOrderId };
    if (status === "REFUNDED") return { status: "REFUNDED", externalOrderId };
    return { status: "REJECTED", externalOrderId };
  }
  // QCST documents delivery as untyped JSON. It is intentionally never mapped to an asset.
  return { status: "PENDING", externalOrderId };
}

function mapOrderToCreate(order: QcstOrder): CreateOrderResult {
  const status = order.status.trim().toUpperCase();
  if (["FAILED", "REJECTED", "CANCELLED", "REFUNDED", "REFUND_FAILED"].includes(status)) {
    return {
      kind: "REJECTED",
      code: order.error?.code ?? "QCST_ORDER_REJECTED",
      retryable: false,
    };
  }
  if (hasUnsupportedDelivery(order)) {
    return { kind: "UNKNOWN", queryKey: order.id, reason: "delivery_schema_unsupported" };
  }
  return {
    kind: "ACCEPTED",
    externalOrderId: order.id,
    status: status === "PENDING" ? "PENDING" : "SUBMITTED",
  };
}

export function createQcstSupplierPort(
  options: QcstSupplierOptions,
): SupplierProvider & QcstCatalogPort {
  const base = validateOptions(options);
  const testHttp =
    options.testTransport?.allowInsecureLoopback === true && base.protocol === "http:";
  const guardedFetch = createPinnedFetch({
    allowInsecureLoopback: testHttp,
    allowedHosts: [base.hostname],
    allowedPorts: [base.port ? Number(base.port) : testHttp ? 80 : 443],
    timeoutMs: options.timeoutMs,
    ...(options.testTransport?.fetch ? { fetchImpl: options.testTransport.fetch } : {}),
  });

  const request = async <T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    parse(value: unknown): T;
  }): Promise<T> => {
    const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (serialized && Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
      throw new SupplierPortError("REQUEST_TOO_LARGE", "QCST request is invalid");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("QCST_TIMEOUT")), options.timeoutMs);
    try {
      let apiKey: string;
      try {
        apiKey = await options.vault.reveal(options.apiKeyVaultRef);
      } catch {
        throw new SupplierPortError("CREDENTIAL_UNAVAILABLE", "QCST credential is unavailable");
      }
      if (!/^[\x21-\x7e]{16,512}$/.test(apiKey) || !apiKey.startsWith("qcst_live_")) {
        throw new SupplierPortError("CREDENTIAL_INVALID", "QCST credential is invalid");
      }
      let response: Response;
      try {
        response = await guardedFetch(new URL(input.path, `${base.origin}/`), {
          method: input.method,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "x-api-key": apiKey,
            ...(serialized ? { "content-type": "application/json" } : {}),
            ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
          },
          ...(serialized ? { body: serialized } : {}),
        });
      } catch (error) {
        if (error instanceof OutboundPolicyError) {
          throw new SupplierPortError("CONFIG_INVALID", "QCST endpoint is not allowed");
        }
        if (controller.signal.aborted) {
          throw new SupplierPortError("TRANSPORT_TIMEOUT", "QCST request timed out");
        }
        throw new SupplierPortError("TRANSPORT_ERROR", "QCST request failed");
      }
      const retryAfter = retryAfterSeconds(response);
      const value = await readBounded(response, controller.signal);
      if (!response.ok) throw responseError(response.status, retryAfter);
      try {
        return input.parse(value);
      } catch (error) {
        if (error instanceof SupplierPortError) throw error;
        throw new SupplierPortError("SCHEMA_INVALID", "QCST response is invalid");
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const listProducts = async (): Promise<readonly NormalizedSupplierProduct[]> => {
    const response = await request({
      method: "GET",
      path: "/v1/products",
      parse: (value) => ProductListResponseSchema.parse(value),
    });
    return response.data.map(normalizeQcstProduct);
  };

  const getProduct = async (externalProductId: string): Promise<NormalizedSupplierProduct> => {
    const response = await request({
      method: "GET",
      path: `/v1/products/${encodeURIComponent(externalProductId)}`,
      parse: (value) => ProductResponseSchema.parse(value),
    });
    return normalizeQcstProduct(response.data);
  };

  const getBalance = async (): Promise<QcstBalance> => {
    const response = await request({
      method: "GET",
      path: "/v1/balance",
      parse: (value) => BalanceResponseSchema.parse(value),
    });
    return response.data;
  };

  const getOrder = async (input: QueryOrderInput): Promise<QcstOrder> => {
    if (input.externalOrderId) {
      const response = await request({
        method: "GET",
        path: `/v1/orders/${encodeURIComponent(input.externalOrderId)}`,
        parse: (value) => OrderResponseSchema.parse(value),
      });
      return response.data;
    }
    const queryKey = input.queryKey?.trim();
    if (!queryKey) throw new SupplierPortError("INVALID_QUERY", "QCST order query is invalid");
    const query = new URLSearchParams({ client_order_id: queryKey, limit: "1" });
    const response = await request({
      method: "GET",
      path: `/v1/orders?${query}`,
      parse: (value) => OrderListResponseSchema.parse(value),
    });
    const order = response.data.items[0];
    if (!order) throw new SupplierPortError("NOT_FOUND", "QCST order was not found");
    return order;
  };

  return {
    providerKey: "qcst",
    displayName: "QCST",
    capabilities: new Set<SupplierCapability>([
      "CATALOG_LIST",
      "CATALOG_DETAIL",
      "BALANCE_READ",
      "ORDER_CREATE",
      "ORDER_READ",
      "ORDER_LIST",
      "NATIVE_IDEMPOTENCY",
      "CANCEL",
      "STOCK_QUANTITY",
      "RATE_LIMIT_RETRY_AFTER",
    ]),
    listProducts,
    getProduct,
    getBalance,
    async getAvailability(input) {
      const products = await listProducts();
      const product = products.find((item) => item.externalProductId === input.supplierSku);
      if (!product) throw new SupplierPortError("NOT_FOUND", "QCST product was not found");
      return {
        status: product.availability,
        observedAt: new Date().toISOString(),
        supplierReference: product.externalProductId,
        ...(product.stockQuantity === null ? {} : { quantity: product.stockQuantity }),
      };
    },
    async createOrder(input: CreateOrderInput) {
      try {
        const response = await request({
          method: "POST",
          path: "/v1/orders",
          body: {
            client_order_id: input.idempotencyKey,
            product_id: input.supplierSku,
            quantity: 1,
            customer_inputs: [],
            locale: "vi",
            max_unit_price: input.costCeilingVnd,
          },
          idempotencyKey: input.idempotencyKey,
          parse: (value) => OrderResponseSchema.parse(value),
        });
        return mapOrderToCreate(response.data);
      } catch (error) {
        if (isTransportError(error)) {
          return { kind: "UNKNOWN", queryKey: input.idempotencyKey, reason: "transport_timeout" };
        }
        throw error;
      }
    },
    async queryOrder(input) {
      const order = await getOrder(input);
      if (hasUnsupportedDelivery(order)) {
        throw new SupplierPortError("DELIVERY_UNSUPPORTED", "QCST delivery schema is unsupported");
      }
      return mapOrderToQuery(order);
    },
    async cancelOrder(input: SupplierActionInput): Promise<SupplierActionResult> {
      const response = await request({
        method: "POST",
        path: `/v1/orders/${encodeURIComponent(input.externalOrderId)}/cancel`,
        parse: (value) => CancelOrderResponseSchema.parse(value),
      });
      const status = response.data.status.trim().toUpperCase();
      return {
        status: status === "CANCELLED" || status === "REFUNDED" ? "FINAL" : "PENDING",
      };
    },
    async requestRefund(_input: SupplierActionInput): Promise<SupplierActionResult> {
      return { status: "UNSUPPORTED" };
    },
    async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
      const query = new URLSearchParams({
        limit: String(Math.min(100, Math.max(1, input.limit))),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const response = await request({
        method: "GET",
        path: `/v1/orders?${query}`,
        parse: (value) => OrderListResponseSchema.parse(value),
      });
      return {
        observations: response.data.items.map(mapOrderToQuery),
        nextCursor: response.data.has_more ? response.data.next_cursor : null,
      };
    },
  };
}
