import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import { createSupplierProviderResolver } from "../../src/modules/supplier/resolver.js";
import {
  assertNormalizedSupplierProduct,
  SupplierPortError,
} from "../../src/modules/supplier/port.js";
import {
  RawQcstProductSchema,
  createQcstSupplierPort,
  normalizeQcstProduct,
} from "../../src/modules/supplier/adapters/qcst.js";
import { checkSupplierProviderReadiness } from "../../src/modules/supplier/readiness.js";

const AUTH_FIXTURE = ["qcst", "live", "test", "fixture", "123"].join("_");
const CREATE_INPUT = {
  idempotencyKey: "supplier-order:qcst-1",
  supplierSku: "NF-1M-PREMIUM",
  costCeilingVnd: 150_000,
  orderId: "ord-qcst-1",
  region: "VN",
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

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function qcstOrder(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "qcst-order-1",
    client_order_id: CREATE_INPUT.idempotencyKey,
    product_id: CREATE_INPUT.supplierSku,
    quantity: 1,
    unit_price: 150_000,
    total_amount: 150_000,
    currency: "VND",
    status,
    payment_status: "PENDING",
    cancellable: true,
    delivery_available: false,
    delivery: null,
    delivery_expires_at: null,
    error: null,
    status_url: "https://api.qcst.tech/v1/orders/qcst-order-1",
    poll_after_seconds: 5,
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

async function createPort(baseUrl: string) {
  const vault = createInMemoryVault();
  const apiKeyVaultRef = await vault.write(AUTH_FIXTURE);
  return createQcstSupplierPort({
    baseUrl,
    apiKeyVaultRef,
    vault,
    timeoutMs: 500,
    testTransport: { allowInsecureLoopback: true },
  });
}
function qcstProduct(overrides: Partial<Parameters<typeof normalizeQcstProduct>[0]> = {}) {
  return RawQcstProductSchema.parse({
    id: "qcst-product-1",
    name: "QCST product",
    name_en: "QCST product",
    description: "",
    description_en: "",
    warranty: "",
    warranty_en: "",
    customer_input_type: "",
    requires_customer_input: false,
    customer_inputs_per_item: 0,
    customer_prompt: "",
    customer_prompt_en: "",
    fulfillment_mode: "AUTO",
    availability: "AVAILABLE",
    stock_type: "STOCK",
    stock_quantity: 5,
    min_quantity: 1,
    max_quantity: 10,
    fixed_quantity: null,
    price: 150_000,
    currency: "VND",
    updated_at: "2026-10-21T00:00:00.000Z",
    ...overrides,
  });
}

async function checkQcstAvailabilityReadiness(stockQuantity: number | undefined) {
  const paths: string[] = [];
  const server = await startServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/v1/balance") {
      sendJson(response, {
        success: true,
        data: { available: 1_000_000, currency: "VND" },
      });
      return;
    }
    if (request.url === "/v1/products") {
      sendJson(response, {
        success: true,
        data: [qcstProduct({ stock_quantity: stockQuantity })],
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const readiness = await checkSupplierProviderReadiness(await createPort(server.baseUrl), {
    supplierSku: "qcst-product-1",
    region: null,
  });
  return { readiness, paths };
}

describe("QCST availability readiness", () => {
  it("fails readiness when STOCK_QUANTITY reports zero with AVAILABLE status", async () => {
    const observed = await checkQcstAvailabilityReadiness(0);
    expect(observed.readiness).toEqual({ ok: false, reason: "SUPPLIER_UNAVAILABLE" });
    expect(observed.paths).toEqual(["/v1/balance", "/v1/products"]);
  });

  it("keeps status-based readiness when STOCK_QUANTITY omits quantity", async () => {
    const observed = await checkQcstAvailabilityReadiness(undefined);
    expect(observed.readiness).toEqual({ ok: true });
    expect(observed.paths).toEqual(["/v1/balance", "/v1/products"]);
  });
});

describe("QCST resolver catalog identity", () => {
  it("binds listed and fetched products to the persisted supplier ID", async () => {
    const supplierId = "supplier-opaque-qcst-01";
    const vault = createInMemoryVault();
    const apiKeyVaultRef = await vault.write(AUTH_FIXTURE);
    const server = await startServer((request, response) => {
      if (request.url === "/v1/products") {
        sendJson(response, { success: true, data: [qcstProduct()] });
        return;
      }
      if (request.url === "/v1/products/qcst-product-1") {
        sendJson(response, { success: true, data: qcstProduct() });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const providerResolver = createSupplierProviderResolver({} as Db, vault, {
      loadRow: async () => ({
        id: supplierId,
        name: "QCST test",
        adapter_type: "qcst",
        credential_vault_ref: apiKeyVaultRef,
        status: "ACTIVE",
        timeout_policy: { autoFailover: false },
        base_url: server.baseUrl,
        provider_capabilities: [
          "HEALTH_READ",
          "CATALOG_LIST",
          "CATALOG_DETAIL",
          "ORDER_CREATE",
          "ORDER_READ",
          "ORDER_LIST",
          "NATIVE_IDEMPOTENCY",
          "CANCEL",
          "STOCK_QUANTITY",
          "RATE_LIMIT_RETRY_AFTER",
        ],
        version: 1,
      }),
      testTransport: { allowInsecureLoopback: true },
    });

    const provider = await providerResolver.resolve(supplierId);
    if (!provider?.listProducts || !provider.getProduct) {
      throw new Error("QCST catalog methods unavailable");
    }
    const [products, product] = await Promise.all([
      provider.listProducts(),
      provider.getProduct("qcst-product-1"),
    ]);

    expect(products).toHaveLength(1);
    expect(products[0]?.providerKey).toBe(supplierId);
    expect(product.providerKey).toBe(supplierId);
  });
});

describe("QCST order status validation", () => {
  it("returns UNKNOWN with the stable query key for an unknown create status", async () => {
    let idempotencyKey: string | undefined;
    const server = await startServer((request, response) => {
      const header = request.headers["idempotency-key"];
      idempotencyKey = typeof header === "string" ? header : undefined;
      sendJson(response, {
        success: true,
        data: qcstOrder("QUEUED"),
      });
    });

    const result = await (await createPort(server.baseUrl)).createOrder(CREATE_INPUT);

    expect(result).toEqual({
      kind: "UNKNOWN",
      queryKey: CREATE_INPUT.idempotencyKey,
      reason: "status_unknown",
    });
    expect(idempotencyKey).toBe(CREATE_INPUT.idempotencyKey);
  });
  it("surfaces create identity mismatches as reviewable errors", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, {
        success: true,
        data: qcstOrder("PENDING", { product_id: "different-sku" }),
      });
    });

    await expect(
      (await createPort(server.baseUrl)).createOrder(CREATE_INPUT),
    ).rejects.toMatchObject({
      name: "SupplierPortError",
      supplierCode: "IDENTITY_MISMATCH",
    });
  });

  it("fails closed when querying an order with an unknown status", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, {
        success: true,
        data: qcstOrder("QUEUED"),
      });
    });

    await expect(
      (await createPort(server.baseUrl)).queryOrder({
        externalOrderId: "qcst-order-1",
        expectedSku: CREATE_INPUT.supplierSku,
      }),
    ).rejects.toMatchObject({
      name: "SupplierPortError",
      supplierCode: "SCHEMA_INVALID",
    });
  });

  it("fails closed when reconciling an order with an unknown status", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, {
        success: true,
        data: {
          items: [qcstOrder("QUEUED")],
          has_more: false,
          next_cursor: null,
        },
      });
    });
    const reconciliation = (await createPort(server.baseUrl)).reconcile({ limit: 10 });
    await expect(reconciliation).rejects.toBeInstanceOf(SupplierPortError);
    await expect(reconciliation).rejects.toMatchObject({
      supplierCode: "SCHEMA_INVALID",
    });
  });
});
describe("QCST catalog support semantics", () => {
  it.each([
    {
      name: "required customer inputs",
      overrides: { requires_customer_input: true, customer_inputs_per_item: 1 },
      unsupportedReason: "CUSTOMER_INPUT_UNSUPPORTED",
    },
    {
      name: "minimum quantity above one",
      overrides: { min_quantity: 2 },
      unsupportedReason: "QUANTITY_UNSUPPORTED",
    },
    {
      name: "fixed quantity above one",
      overrides: { fixed_quantity: 2 },
      unsupportedReason: "QUANTITY_UNSUPPORTED",
    },
    {
      name: "positive input count without required flag",
      overrides: { requires_customer_input: false, customer_inputs_per_item: 1 },
      unsupportedReason: "CUSTOMER_INPUT_COUNT_INCONSISTENT",
    },
  ])("marks $name as unsupported", ({ overrides, unsupportedReason }) => {
    expect(normalizeQcstProduct(qcstProduct(overrides))).toMatchObject({
      supportStatus: "UNSUPPORTED",
      unsupportedReason,
    });
  });

  it("rejects explicit max-quantity zero instead of treating it as a null sentinel", () => {
    expect(() => normalizeQcstProduct(qcstProduct({ max_quantity: 0 }))).toThrow(
      "QCST_PRODUCT_INVALID",
    );
  });

  it("rejects explicit fixed-quantity zero instead of treating it as a null sentinel", () => {
    expect(() => normalizeQcstProduct(qcstProduct({ fixed_quantity: 0 }))).toThrow(
      "QCST_PRODUCT_INVALID",
    );
  });

  it("preserves zero stock as an OUT availability fact", () => {
    expect(
      normalizeQcstProduct(qcstProduct({ availability: "OUT_OF_STOCK", stock_quantity: 0 })),
    ).toMatchObject({
      availability: "OUT",
      stockQuantity: 0,
    });
  });

  it("trims QCST external identifiers before normalization", () => {
    expect(normalizeQcstProduct(qcstProduct({ id: " qcst-product-1 " })).externalProductId).toBe(
      "qcst-product-1",
    );
  });

  it.each([
    { name: "blank product ID", patch: { externalProductId: "   " } },
    { name: "leading product ID whitespace", patch: { externalProductId: " qcst-product-1" } },
    { name: "trailing product ID whitespace", patch: { externalProductId: "qcst-product-1 " } },
    { name: "product ID control character", patch: { externalProductId: "qcst-\u0001-product-1" } },
    { name: "provider key whitespace", patch: { providerKey: " qcst" } },
    { name: "variant ID whitespace", patch: { externalVariantId: " variant-1 " } },
  ])("rejects a non-canonical normalized identifier ($name)", ({ patch }) => {
    const supported = normalizeQcstProduct(qcstProduct());
    expect(() => assertNormalizedSupplierProduct({ ...supported, ...patch })).toThrow(
      "SUPPLIER_PRODUCT_INVALID",
    );
  });

  it("preserves unsupported inconsistent quantity bounds but rejects supported ones", () => {
    expect(normalizeQcstProduct(qcstProduct({ min_quantity: 3, max_quantity: 2 }))).toMatchObject({
      minQuantity: 3,
      maxQuantity: 2,
      supportStatus: "UNSUPPORTED",
      unsupportedReason: "QUANTITY_BOUNDS_INCONSISTENT",
    });

    const supported = normalizeQcstProduct(qcstProduct());
    expect(() => assertNormalizedSupplierProduct({ ...supported, maxQuantity: 0 })).toThrow(
      "SUPPLIER_PRODUCT_INVALID",
    );
  });

  it("rejects a non-VND price before normalization", () => {
    expect(() => normalizeQcstProduct(qcstProduct({ currency: "USD" }))).toThrow(
      "QCST_PRODUCT_INVALID",
    );
  });

  it.each([
    {
      name: "customer input",
      overrides: { requiresCustomerInput: true, customerInputsPerItem: 1 },
    },
    { name: "minimum quantity", overrides: { minQuantity: 2 } },
    { name: "maximum quantity zero", overrides: { maxQuantity: 0 } },
    { name: "fixed quantity", overrides: { fixedQuantity: 2 } },
    { name: "fixed quantity zero", overrides: { fixedQuantity: 0 } },
    {
      name: "positive input count without required flag",
      overrides: { requiresCustomerInput: false, customerInputsPerItem: 1 },
    },
  ])("rejects a product falsely marked supported for $name", ({ overrides }) => {
    const supported = normalizeQcstProduct(qcstProduct());
    expect(() => assertNormalizedSupplierProduct({ ...supported, ...overrides })).toThrow(
      "SUPPLIER_PRODUCT_INVALID",
    );
  });
});
