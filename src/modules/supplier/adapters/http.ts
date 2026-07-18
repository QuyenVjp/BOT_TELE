import { z } from "zod";
import type { Vault } from "../../../infrastructure/vault/port.js";
import {
  AssetEnvelopeSchema,
  CreateOrderResultSchema,
  QueryOrderResultSchema,
  SupplierPortError,
  type AssetEnvelope,
  type CreateOrderInput,
  type CreateOrderResult,
  type SupplierPort,
} from "../port.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 8 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const AvailabilitySchema = z
  .object({
    status: z.enum(["AVAILABLE", "LOW", "OUT", "UNKNOWN"]),
    observedAt: z.string().datetime(),
    supplierReference: z.string().min(1).max(200).optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
const ActionSchema = z
  .object({ status: z.enum(["ACCEPTED", "PENDING", "FINAL", "UNSUPPORTED"]) })
  .strict();
const ReconcileSchema = z
  .object({
    observations: z.array(z.unknown()).max(100),
    nextCursor: z.string().min(1).max(500).nullable(),
  })
  .strict();
const WireAssetSchema = AssetEnvelopeSchema.omit({ vaultRef: true })
  .extend({ secretMaterial: z.string().min(1) })
  .strict();
const WireCreateSchema = z.discriminatedUnion("kind", [
  CreateOrderResultSchema.options[0],
  z
    .object({
      kind: z.literal("FULFILLED"),
      externalOrderId: z.string().min(1).max(200),
      assetEnvelope: WireAssetSchema,
    })
    .strict(),
  CreateOrderResultSchema.options[2],
  CreateOrderResultSchema.options[3],
]);
const WireQuerySchema = z.discriminatedUnion("status", [
  QueryOrderResultSchema.options[0],
  z
    .object({
      status: z.literal("FULFILLED"),
      externalOrderId: z.string().min(1).max(200),
      assetEnvelope: WireAssetSchema,
    })
    .strict(),
  QueryOrderResultSchema.options[2],
  QueryOrderResultSchema.options[3],
  QueryOrderResultSchema.options[4],
]);

export interface HttpSupplierOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxAttempts: number;
  vault: Vault;
  testTransport?: { allowInsecureLoopback?: boolean; fetch?: typeof fetch };
}

function validateOptions(options: HttpSupplierOptions): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new SupplierPortError("CONFIG_INVALID", "supplier configuration is invalid");
  }
  const testHttp =
    options.testTransport?.allowInsecureLoopback === true &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !testHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !options.token.trim() ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 10 ||
    options.timeoutMs > 30_000 ||
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 5
  ) {
    throw new SupplierPortError("CONFIG_INVALID", "supplier configuration is invalid");
  }
  return url;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierPortError("CONTENT_TYPE_INVALID", "supplier response is invalid");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SupplierPortError("RESPONSE_INVALID", "supplier response is invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new SupplierPortError("RESPONSE_TOO_LARGE", "supplier response is invalid");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
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
    throw new SupplierPortError("RESPONSE_INVALID", "supplier response is invalid");
  }
}

export function createHttpSupplierPort(options: HttpSupplierOptions): SupplierPort {
  const base = validateOptions(options);
  const fetchImpl = options.testTransport?.fetch ?? fetch;

  const request = async <T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    attempts?: number;
    parse(value: unknown): T;
  }): Promise<T> => {
    const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (serialized && Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
      throw new SupplierPortError("REQUEST_TOO_LARGE", "supplier request is invalid");
    }
    const attempts = input.attempts ?? options.maxAttempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("SUPPLIER_TIMEOUT")),
        options.timeoutMs,
      );
      try {
        const response = await fetchImpl(
          new URL(input.path, `${base.toString().replace(/\/$/, "")}/`),
          {
            method: input.method,
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${options.token}`,
              accept: "application/json",
              ...(serialized ? { "content-type": "application/json" } : {}),
              ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
            },
            ...(serialized ? { body: serialized } : {}),
          },
        );
        const value = await readBounded(response, controller.signal);
        if (!response.ok) throw new SupplierPortError("HTTP_ERROR", "supplier response is invalid");
        return input.parse(value);
      } catch (error) {
        if (attempt === attempts || error instanceof SupplierPortError) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SupplierPortError("TRANSPORT_ERROR", "supplier request failed");
  };

  const ingest = async (
    externalOrderId: string,
    wire: z.infer<typeof WireAssetSchema>,
  ): Promise<AssetEnvelope> => {
    if (Buffer.byteLength(wire.secretMaterial, "utf8") > MAX_SECRET_BYTES) {
      throw new SupplierPortError("ASSET_TOO_LARGE", "supplier asset failed validation");
    }
    const vaultRef = await options.vault.write(wire.secretMaterial, {
      namespace: "asset",
      idempotencyKey: `supplier:${externalOrderId}:${wire.supplierAssetId}`,
    });
    const { secretMaterial: _secretMaterial, ...safe } = wire;
    return AssetEnvelopeSchema.parse({ ...safe, vaultRef });
  };

  const mapCreate = async (value: unknown): Promise<CreateOrderResult> => {
    const parsed = WireCreateSchema.safeParse(value);
    if (!parsed.success)
      throw new SupplierPortError("SCHEMA_INVALID", "supplier response is invalid");
    if (parsed.data.kind !== "FULFILLED") return parsed.data;
    return {
      kind: "FULFILLED",
      externalOrderId: parsed.data.externalOrderId,
      assetEnvelope: await ingest(parsed.data.externalOrderId, parsed.data.assetEnvelope),
    };
  };

  return {
    getAvailability(input) {
      const query = new URLSearchParams({
        supplierSku: input.supplierSku,
        ...(input.region ? { region: input.region } : {}),
      });
      return request({
        method: "GET",
        path: `availability?${query}`,
        parse: (v) => AvailabilitySchema.parse(v),
      });
    },
    async createOrder(input: CreateOrderInput) {
      try {
        const raw = await request({
          method: "POST",
          path: "orders",
          body: input,
          idempotencyKey: input.idempotencyKey,
          attempts: 1,
          parse: (v) => v,
        });
        return await mapCreate(raw);
      } catch (error) {
        if (!(error instanceof SupplierPortError))
          return { kind: "UNKNOWN", queryKey: input.idempotencyKey, reason: "transport_timeout" };
        throw error;
      }
    },
    async queryOrder(input) {
      const query = new URLSearchParams(
        input.externalOrderId
          ? { externalOrderId: input.externalOrderId }
          : { queryKey: input.queryKey ?? "" },
      );
      const raw = await request({ method: "GET", path: `orders/query?${query}`, parse: (v) => v });
      const parsed = WireQuerySchema.safeParse(raw);
      if (!parsed.success)
        throw new SupplierPortError("SCHEMA_INVALID", "supplier response is invalid");
      if (parsed.data.status !== "FULFILLED") return parsed.data;
      return {
        status: "FULFILLED",
        externalOrderId: parsed.data.externalOrderId,
        assetEnvelope: await ingest(parsed.data.externalOrderId, parsed.data.assetEnvelope),
      };
    },
    cancelOrder(input) {
      return request({
        method: "POST",
        path: `orders/${encodeURIComponent(input.externalOrderId)}/cancel`,
        body: { reason: input.reason },
        idempotencyKey: input.idempotencyKey,
        parse: (v) => ActionSchema.parse(v),
      });
    },
    requestRefund(input) {
      return request({
        method: "POST",
        path: `orders/${encodeURIComponent(input.externalOrderId)}/refund`,
        body: { reason: input.reason },
        idempotencyKey: input.idempotencyKey,
        parse: (v) => ActionSchema.parse(v),
      });
    },
    async reconcile(input) {
      const query = new URLSearchParams({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.since ? { since: input.since } : {}),
        limit: String(input.limit),
      });
      const parsed = await request({
        method: "GET",
        path: `reconcile?${query}`,
        parse: (v) => ReconcileSchema.parse(v),
      });
      return {
        observations: parsed.observations.map((item) => QueryOrderResultSchema.parse(item)),
        nextCursor: parsed.nextCursor,
      };
    },
  };
}
