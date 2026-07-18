import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createHttpSupplierPort } from "../../src/modules/supplier/adapters/http.js";

const AUTHORIZATION_FIXTURE = "test-only-supplier-auth-value";
const CREATE_INPUT = {
  idempotencyKey: "supplier-order:ord-1",
  supplierSku: "NF-1M-PREMIUM",
  costCeilingVnd: 150_000,
  orderId: "ord-1",
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function wireAsset(secretMaterial = "supplier-user:supplier-password") {
  return {
    deliveryType: "CREDENTIAL",
    expectedSku: CREATE_INPUT.supplierSku,
    region: "VN",
    durationCode: "P1M",
    expiresAt: null,
    supplierAssetId: "asset-1",
    fingerprint: "supplier-fingerprint-1",
    secretMaterial,
  };
}

function createPort(baseUrl: string, timeoutMs = 500) {
  return createHttpSupplierPort({
    baseUrl,
    token: AUTHORIZATION_FIXTURE,
    timeoutMs,
    maxAttempts: 2,
    vault: createInMemoryVault(),
    testTransport: { allowInsecureLoopback: true },
  });
}

describe("authenticated HTTP SupplierPort (T137 RED)", () => {
  it("authenticates and validates bounded availability", async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const server = await startServer((request, response) => {
      seen.push({ url: request.url!, authorization: request.headers.authorization });
      sendJson(response, {
        status: "AVAILABLE",
        observedAt: "2026-07-18T00:00:00.000Z",
        supplierReference: "stock-1",
        quantity: 3,
      });
    });
    const result = await createPort(server.baseUrl).getAvailability({
      supplierSku: CREATE_INPUT.supplierSku,
      region: "VN",
    });
    expect(result).toMatchObject({ status: "AVAILABLE", supplierReference: "stock-1" });
    expect(seen).toEqual([
      {
        url: `/availability?supplierSku=${CREATE_INPUT.supplierSku}&region=VN`,
        authorization: `Bearer ${AUTHORIZATION_FIXTURE}`,
      },
    ]);
  });

  it("writes fulfilled secret material directly to vault with stable provenance", async () => {
    const bodies: unknown[] = [];
    const idempotency: Array<string | undefined> = [];
    const server = await startServer(async (request, response) => {
      bodies.push(await readJson(request));
      idempotency.push(request.headers["idempotency-key"] as string | undefined);
      sendJson(response, {
        kind: "FULFILLED",
        externalOrderId: "supplier-order-1",
        assetEnvelope: wireAsset(),
      });
    });
    const vault = createInMemoryVault();
    const port = createHttpSupplierPort({
      baseUrl: server.baseUrl,
      token: AUTHORIZATION_FIXTURE,
      timeoutMs: 500,
      maxAttempts: 2,
      vault,
      testTransport: { allowInsecureLoopback: true },
    });
    const result = await port.createOrder(CREATE_INPUT);
    expect(result.kind).toBe("FULFILLED");
    if (result.kind !== "FULFILLED") return;
    expect(result.assetEnvelope).not.toHaveProperty("secretMaterial");
    expect(result.assetEnvelope.vaultRef).toMatch(/^vault:/);
    await expect(vault.reveal(result.assetEnvelope.vaultRef)).resolves.toBe(
      "supplier-user:supplier-password",
    );
    expect(idempotency).toEqual([CREATE_INPUT.idempotencyKey]);
    expect(bodies).toEqual([CREATE_INPUT]);
  });

  it("maps a create timeout to UNKNOWN without automatically retrying", async () => {
    let calls = 0;
    const server = await startServer((_request, _response) => {
      calls += 1;
    });
    const result = await createPort(server.baseUrl, 25).createOrder(CREATE_INPUT);
    expect(result).toEqual({
      kind: "UNKNOWN",
      queryKey: CREATE_INPUT.idempotencyKey,
      reason: "transport_timeout",
    });
    expect(calls).toBe(1);
  });

  it("supports query, cancel, refund, and paginated reconcile with stable idempotency", async () => {
    const paths: string[] = [];
    const server = await startServer(async (request, response) => {
      paths.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url?.startsWith("/orders/query")) {
        sendJson(response, { status: "PENDING", externalOrderId: "supplier-order-1" });
        return;
      }
      if (request.url?.endsWith("/cancel")) {
        await readJson(request);
        sendJson(response, { status: "ACCEPTED" });
        return;
      }
      if (request.url?.endsWith("/refund")) {
        await readJson(request);
        sendJson(response, { status: "PENDING" });
        return;
      }
      sendJson(response, {
        observations: [{ status: "CANCELLED", externalOrderId: "supplier-order-1" }],
        nextCursor: "cursor-2",
      });
    });
    const port = createPort(server.baseUrl);
    await expect(port.queryOrder({ queryKey: CREATE_INPUT.idempotencyKey })).resolves.toMatchObject(
      {
        status: "PENDING",
      },
    );
    await expect(
      port.cancelOrder({
        externalOrderId: "supplier-order-1",
        idempotencyKey: "cancel:ord-1",
        reason: "customer_cancelled",
      }),
    ).resolves.toEqual({ status: "ACCEPTED" });
    await expect(
      port.requestRefund({
        externalOrderId: "supplier-order-1",
        idempotencyKey: "refund:ord-1",
        reason: "invalid_asset",
      }),
    ).resolves.toEqual({ status: "PENDING" });
    await expect(port.reconcile({ cursor: "cursor-1", limit: 20 })).resolves.toMatchObject({
      nextCursor: "cursor-2",
    });
    expect(paths).toEqual([
      `GET /orders/query?queryKey=${encodeURIComponent(CREATE_INPUT.idempotencyKey)}`,
      "POST /orders/supplier-order-1/cancel",
      "POST /orders/supplier-order-1/refund",
      "GET /reconcile?cursor=cursor-1&limit=20",
    ]);
  });

  it("rejects wrong content type and malformed success without leaking response material", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("supplier-secret-must-not-appear-in-error");
    });
    await expect(
      createPort(server.baseUrl).getAvailability({ supplierSku: "SKU-1" }),
    ).rejects.toThrow(/supplier response/i);
  });
});
