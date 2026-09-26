import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  normalizeQcstProduct,
  RawQcstProductSchema,
  createQcstSupplierPort,
} from "../../src/modules/supplier/adapters/qcst.js";

const API_KEY = ["qcst", "live", "x".repeat(32)].join("_");
const PRODUCT = {
  id: "product-1",
  name: "QCST Product",
  name_en: "QCST Product",
  description: "description",
  description_en: "description",
  warranty: "warranty",
  warranty_en: "warranty",
  customer_input_type: "NONE",
  requires_customer_input: false,
  customer_inputs_per_item: 0,
  customer_prompt: "",
  customer_prompt_en: "",
  fulfillment_mode: "AUTOMATIC",
  availability: "AVAILABLE",
  stock_type: "FINITE",
  stock_quantity: 4,
  min_quantity: 1,
  max_quantity: 1,
  fixed_quantity: 1,
  price: 100_000,
  pricing_source: "BASE",
  currency: "VND",
  updated_at: "2026-09-24T00:00:00Z",
};

const ORDER = {
  id: "qcst-order-1",
  client_order_id: "supplier-order:ord-1",
  product_id: PRODUCT.id,
  quantity: 1,
  unit_price: PRODUCT.price,
  total_amount: PRODUCT.price,
  currency: "VND",
  status: "PENDING",
  payment_status: "PAID",
  cancellable: false,
  delivery_available: false,
  delivery: null,
  delivery_expires_at: null,
  error: null,
  status_url: "https://api.qcst.tech/v1/orders/qcst-order-1",
  poll_after_seconds: 10,
  created_at: "2026-09-24T00:00:00Z",
  updated_at: "2026-09-24T00:00:00Z",
};

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server failed to bind");
  const handle = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(handle);
  return handle;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function createPort(baseUrl: string, timeoutMs = 500) {
  const vault = createInMemoryVault();
  const apiKeyVaultRef = await vault.write(API_KEY, { namespace: "asset" });
  return {
    vault,
    port: createQcstSupplierPort({
      baseUrl,
      apiKeyVaultRef,
      timeoutMs,
      vault,
      testTransport: { allowInsecureLoopback: true },
    }),
  };
}

describe("QCST supplier adapter", () => {
  it("authenticates with X-API-Key and strips unknown product fields", async () => {
    const seen: Array<{ path: string; hasApiKey: boolean; authorization: string | undefined }> = [];
    const server = await startServer((request, response) => {
      seen.push({
        path: request.url ?? "",
        hasApiKey: typeof request.headers["x-api-key"] === "string",
        authorization: request.headers.authorization,
      });
      sendJson(response, {
        success: true,
        data: [{ ...PRODUCT, secret_material: "must-not-cross" }],
      });
    });
    const { port } = await createPort(server.baseUrl);

    const products = await port.listProducts();

    expect(products).toEqual([
      expect.objectContaining({
        providerKey: "qcst",
        externalProductId: PRODUCT.id,
        externalVariantId: null,
        nameVi: PRODUCT.name,
        costVnd: PRODUCT.price,
        availability: "AVAILABLE",
        stockQuantity: PRODUCT.stock_quantity,
      }),
    ]);
    expect(products[0]).not.toHaveProperty("secret_material");
    expect(port.capabilities.has("CATALOG_LIST")).toBe(true);
    expect(port.capabilities.has("ORDER_CREATE")).toBe(true);
  });

  it("accepts zero customer inputs when QCST says customer input is not required", () => {
    const product = RawQcstProductSchema.parse(PRODUCT);

    expect(normalizeQcstProduct(product)).toMatchObject({
      customerInputsPerItem: 0,
      supportStatus: "SUPPORTED",
      unsupportedReason: null,
    });
  });

  it("quarantines a required-customer-input product with zero inputs", () => {
    const product = RawQcstProductSchema.parse({
      ...PRODUCT,
      requires_customer_input: true,
      customer_inputs_per_item: 0,
    });

    expect(normalizeQcstProduct(product)).toMatchObject({
      customerInputsPerItem: 0,
      supportStatus: "UNSUPPORTED",
      unsupportedReason: "CUSTOMER_INPUT_COUNT_INCONSISTENT",
    });
  });

  it("quarantines max_quantity zero without inventing its meaning", () => {
    const product = RawQcstProductSchema.parse({ ...PRODUCT, max_quantity: 0 });

    expect(normalizeQcstProduct(product)).toMatchObject({
      maxQuantity: 0,
      supportStatus: "UNSUPPORTED",
      unsupportedReason: "MAX_QUANTITY_SEMANTICS_UNKNOWN",
    });
  });

  it("preserves a documented nullable max quantity without inventing a bound", () => {
    const product = RawQcstProductSchema.parse({
      ...PRODUCT,
      max_quantity: null,
      fixed_quantity: null,
    });

    expect(normalizeQcstProduct(product)).toMatchObject({
      maxQuantity: null,
      fixedQuantity: null,
      supportStatus: "SUPPORTED",
      unsupportedReason: null,
    });
  });

  it("uses null when the bounded upstream timestamp is not parseable", () => {
    const product = RawQcstProductSchema.parse({ ...PRODUCT, updated_at: "vendor-time-unknown" });

    expect(normalizeQcstProduct(product).upstreamUpdatedAt).toBeNull();
  });

  it("rejects impossible negative price at the normalized boundary", () => {
    const product = RawQcstProductSchema.parse({ ...PRODUCT, price: -1 });

    expect(() => normalizeQcstProduct(product)).toThrow("QCST_PRODUCT_INVALID");
  });

  it("rejects purchase-ready availability for an unsupported product", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, { success: true, data: [{ ...PRODUCT, max_quantity: 0 }] });
    });
    const { port } = await createPort(server.baseUrl);

    await expect(port.getAvailability({ supplierSku: PRODUCT.id })).rejects.toMatchObject({
      supplierCode: "PRODUCT_UNSUPPORTED",
    });
  });

  it("maps availability and sends the durable client idempotency key with a price ceiling", async () => {
    let body: unknown;
    let idempotencyKey: string | undefined;
    const server = await startServer(async (request, response) => {
      if (request.method === "POST") {
        body = await readJson(request);
        idempotencyKey = request.headers["idempotency-key"] as string | undefined;
        sendJson(response, { success: true, data: ORDER }, 201);
        return;
      }
      sendJson(response, { success: true, data: [PRODUCT] });
    });
    const { port } = await createPort(server.baseUrl);

    await expect(port.getAvailability({ supplierSku: PRODUCT.id })).resolves.toMatchObject({
      status: "AVAILABLE",
      supplierReference: PRODUCT.id,
      quantity: PRODUCT.stock_quantity,
    });
    await expect(
      port.createOrder({
        idempotencyKey: ORDER.client_order_id,
        supplierSku: PRODUCT.id,
        costCeilingVnd: 101_000,
        orderId: "ord-1",
      }),
    ).resolves.toEqual({
      kind: "ACCEPTED",
      externalOrderId: ORDER.id,
      status: "PENDING",
    });

    expect(idempotencyKey).toBe(ORDER.client_order_id);
    expect(body).toEqual({
      client_order_id: ORDER.client_order_id,
      product_id: PRODUCT.id,
      quantity: 1,
      customer_inputs: [],
      locale: "vi",
      max_unit_price: 101_000,
    });
  });

  it("uses the documented QCST cancel endpoint without inventing a refund API", async () => {
    let seen: { method: string; path: string; idempotencyKey: string | undefined } | undefined;
    const server = await startServer((request, response) => {
      seen = {
        method: request.method ?? "",
        path: request.url ?? "",
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      };
      sendJson(response, {
        success: true,
        data: { ...ORDER, status: "CANCELLED", cancellable: false },
        idempotency_replayed: false,
      });
    });
    const { port } = await createPort(server.baseUrl);

    await expect(
      port.cancelOrder({
        externalOrderId: ORDER.id,
        idempotencyKey: "supplier-cancel:ord-1",
        reason: "owner cancellation",
      }),
    ).resolves.toEqual({ status: "FINAL" });
    expect(seen).toEqual({
      method: "POST",
      path: `/v1/orders/${ORDER.id}/cancel`,
      idempotencyKey: undefined,
    });
  });

  it("fails closed when QCST advertises an untyped delivery", async () => {
    const deliveredShape = {
      ...ORDER,
      delivery_available: true,
      delivery: { credential: "opaque" },
    };
    const server = await startServer((request, response) => {
      const body =
        request.method === "GET"
          ? { success: true, data: { items: [deliveredShape], has_more: false, next_cursor: null } }
          : { success: true, data: deliveredShape };
      sendJson(response, body, request.method === "GET" ? 200 : 201);
    });
    const { port } = await createPort(server.baseUrl);

    await expect(
      port.createOrder({
        idempotencyKey: ORDER.client_order_id,
        supplierSku: PRODUCT.id,
        costCeilingVnd: PRODUCT.price,
        orderId: "ord-1",
      }),
    ).resolves.toEqual({
      kind: "UNKNOWN",
      queryKey: deliveredShape.client_order_id,
      reason: "delivery_schema_unsupported",
    });
    await expect(
      port.queryOrder({ queryKey: deliveredShape.client_order_id }),
    ).rejects.toMatchObject({ supplierCode: "DELIVERY_UNSUPPORTED" });
  });

  it("does not echo QCST error bodies and preserves rate-limit classification", async () => {
    const server = await startServer((_request, response) => {
      sendJson(
        response,
        { success: false, error: { code: "secret-internal-code", detail: "secret response body" } },
        429,
        { "retry-after": "30" },
      );
    });
    const { port } = await createPort(server.baseUrl);

    const error = await port.listProducts().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ supplierCode: "HTTP_429" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
  });

  it("maps a stalled response body to a transport timeout", async () => {
    const bodyStarted = Promise.withResolvers<void>();
    const server = await startServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"success":true,"data":[');
      bodyStarted.resolve();
      const closed = Promise.withResolvers<void>();
      response.once("close", () => closed.resolve());
      await closed.promise;
    });
    const { port } = await createPort(server.baseUrl, 100);

    vi.useFakeTimers();
    try {
      const pending = port.listProducts();
      await bodyStarted.promise;
      const assertion = expect(pending).rejects.toMatchObject({
        supplierCode: "TRANSPORT_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
