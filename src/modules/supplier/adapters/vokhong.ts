import { z } from "zod";
import { createPinnedFetch } from "../../../infrastructure/net/pinned-fetch.js";
import { OutboundPolicyError } from "../../../infrastructure/net/outbound-policy.js";
import {
  SupplierPortError,
  type SupplierProvider,
  type SupplierActionInput,
  type SupplierActionResult,
  type AvailabilityResult,
  type CreateOrderInput,
  type CreateOrderResult,
  type QueryOrderInput,
  type QueryOrderResult,
  type ReconcileInput,
  type ReconcileResult,
} from "../port.js";

const MAX_RESPONSE_BYTES = 16 * 1024;
const HealthSchema = z
  .object({ success: z.literal(true), service: z.string().min(1).max(120) })
  .strict();

export interface VokhongSupplierOptions {
  baseUrl: string;
  timeoutMs: number;
  testTransport?: {
    allowInsecureLoopback?: boolean;
    fetch?: typeof fetch;
    resolve?: (hostname: string) => Promise<readonly string[]>;
  };
}

function validateBaseUrl(options: VokhongSupplierOptions): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new SupplierPortError("CONFIG_INVALID", "supplier endpoint is not allowed");
  }
  const loopback =
    options.testTransport?.allowInsecureLoopback === true &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.protocol === "http:";
  if (
    (!loopback &&
      (url.protocol !== "https:" ||
        url.hostname !== "vokhong.xyz" ||
        (url.port !== "" && url.port !== "443"))) ||
    (loopback && !["127.0.0.1", "localhost"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/api" ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 10 ||
    options.timeoutMs > 30_000
  ) {
    throw new SupplierPortError("CONFIG_INVALID", "supplier endpoint is not allowed");
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
      if (size > MAX_RESPONSE_BYTES) {
        throw new SupplierPortError("RESPONSE_TOO_LARGE", "supplier response is invalid");
      }
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

function unsupported(operation: string): never {
  throw new SupplierPortError("UNSUPPORTED", `Vokhong ${operation} is not supported`);
}

export function createVokhongSupplierPort(options: VokhongSupplierOptions): SupplierProvider {
  const base = validateBaseUrl(options);
  const testHttp =
    options.testTransport?.allowInsecureLoopback === true && base.protocol === "http:";
  const guardedFetch = createPinnedFetch({
    allowInsecureLoopback: testHttp,
    allowedHosts: [base.hostname],
    allowedPorts: [base.port ? Number(base.port) : testHttp ? 80 : 443],
    timeoutMs: options.timeoutMs,
    ...(options.testTransport?.resolve ? { resolve: options.testTransport.resolve } : {}),
    ...(options.testTransport?.fetch ? { fetchImpl: options.testTransport.fetch } : {}),
  });

  const health = async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("VOKHONG_TIMEOUT")),
      options.timeoutMs,
    );
    try {
      const response = await guardedFetch(new URL("/", base.origin), {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const value = await readBounded(response, controller.signal);
      if (!response.ok) throw new SupplierPortError("HTTP_ERROR", "supplier response is invalid");
      const parsed = HealthSchema.safeParse(value);
      if (!parsed.success)
        throw new SupplierPortError("SCHEMA_INVALID", "supplier response is invalid");
      return { ready: parsed.data.success, service: parsed.data.service };
    } catch (error) {
      if (error instanceof OutboundPolicyError) {
        throw new SupplierPortError("CONFIG_INVALID", "supplier endpoint is not allowed");
      }
      if (error instanceof SupplierPortError) throw error;
      if (controller.signal.aborted) {
        throw new SupplierPortError("TRANSPORT_TIMEOUT", "supplier request timed out");
      }
      throw new SupplierPortError("TRANSPORT_ERROR", "supplier request failed");
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    providerKey: "vokhong",
    displayName: "Vô Không",
    capabilities: new Set(["HEALTH_READ"]),
    health,
    async getAvailability(_input: {
      supplierSku: string;
      region?: string;
    }): Promise<AvailabilityResult> {
      return unsupported("availability reads");
    },
    async createOrder(_input: CreateOrderInput): Promise<CreateOrderResult> {
      return unsupported("order creation");
    },
    async queryOrder(_input: QueryOrderInput): Promise<QueryOrderResult> {
      return unsupported("order reads");
    },
    async cancelOrder(_input: SupplierActionInput): Promise<SupplierActionResult> {
      return unsupported("order cancellation");
    },
    async requestRefund(_input: SupplierActionInput): Promise<SupplierActionResult> {
      return unsupported("refunds");
    },
    async reconcile(_input: ReconcileInput): Promise<ReconcileResult> {
      return unsupported("reconciliation");
    },
  };
}
