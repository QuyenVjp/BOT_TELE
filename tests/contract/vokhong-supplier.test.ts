import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createVokhongSupplierPort } from "../../src/modules/supplier/adapters/vokhong.js";
import { expectUnsupportedSupplierOperations } from "./supplier-provider-contract.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(body: unknown, status = 200): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server failed to bind");
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${address.port}/api`;
}

function create(baseUrl: string) {
  return createVokhongSupplierPort({
    baseUrl,
    timeoutMs: 500,
    testTransport: { allowInsecureLoopback: true },
  });
}

describe("Vô Không capability-limited supplier adapter", () => {
  it("only exposes the observed health capability and never fakes purchase support", async () => {
    const port = create(await startServer({ success: true, service: "TelegramShopBot" }));
    expect(port.providerKey).toBe("vokhong");
    expect([...port.capabilities]).toEqual(["HEALTH_READ"]);
    await expect(port.health?.()).resolves.toEqual({ ready: true, service: "TelegramShopBot" });
    await expectUnsupportedSupplierOperations(port);
  });

  it("fails closed on an unrecognized health response", async () => {
    const port = create(await startServer({ success: true, secret: "must-not-cross" }));
    await expect(port.health?.()).rejects.toMatchObject({ supplierCode: "SCHEMA_INVALID" });
  });
});
