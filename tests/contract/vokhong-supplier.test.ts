import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createVokhongSupplierPort } from "../../src/modules/supplier/adapters/vokhong.js";
import { expectUnsupportedSupplierOperations } from "./supplier-provider-contract.js";

const servers: Array<{ close(): Promise<void> }> = [];
const fixtureHeaderValue = ["fixture", "vokhong", "key"].join("-");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(
  body: unknown,
  status = 200,
): Promise<{
  url: string;
  requests: Array<{ path: string; apiKey: string | undefined }>;
}> {
  const requests: Array<{ path: string; apiKey: string | undefined }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const header = request.headers["x-api-key"];
    requests.push({
      path: request.url ?? "",
      apiKey: typeof header === "string" ? header : undefined,
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server failed to bind");
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    requests,
  };
}

async function create(baseUrl: string) {
  const vault = createInMemoryVault();
  const apiKeyVaultRef = await vault.write(fixtureHeaderValue);
  return createVokhongSupplierPort({
    baseUrl,
    apiKeyVaultRef,
    vault,
    timeoutMs: 500,
    testTransport: { allowInsecureLoopback: true },
  });
}

describe("Vô Không capability-limited supplier adapter", () => {
  it("uses the Vault API key for the documented health endpoint and exposes no purchase support", async () => {
    const fixture = await startServer({ success: true, service: "TelegramShopBot" });
    const port = await create(fixture.url);
    expect(port.providerKey).toBe("vokhong");
    expect([...port.capabilities]).toEqual(["HEALTH_READ"]);
    await expect(port.health?.()).resolves.toEqual({ ready: true, service: "TelegramShopBot" });
    expect(fixture.requests).toEqual([{ path: "/api/health", apiKey: fixtureHeaderValue }]);
    await expectUnsupportedSupplierOperations(port);
  });

  it("fails closed on an unrecognized health response", async () => {
    const fixture = await startServer({
      success: true,
      unexpectedField: "redacted",
    });
    const port = await create(fixture.url);
    await expect(port.health?.()).rejects.toMatchObject({ supplierCode: "SCHEMA_INVALID" });
  });
});
