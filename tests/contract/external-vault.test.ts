import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createVault,
  ExternalVaultError,
  VaultConfigError,
} from "../../src/infrastructure/vault/adapter.js";
import { createExternalVault } from "../../src/infrastructure/vault/external-adapter.js";

const MAX_MATERIAL_BYTES = 65_536;
const MAX_JSON_ENVELOPE_BYTES = MAX_MATERIAL_BYTES * 6 + 1_024;
const VAULT_TOKEN = ["test", "only", "vault", "token"].join("-");

type RequestRecord = {
  method: string;
  url: string;
  authorization: string;
  body: string;
};

type HealthMode =
  "normal" | "slow-body" | "oversized-chunked" | "redirect" | "malformed" | "invalid-request";

const requests: RequestRecord[] = [];
const stored = new Map<string, string>();
let endpoint = "";
let port = 0;
let transientWriteFailures = 0;
let healthMode: HealthMode = "normal";
let healthContentType = "application/json";
let redirectTargetHits = 0;
let chunkedWritesAttempted = 0;
let chunkedResponseClosed = false;
let deleteReturnsMissing = false;
let deleteBodyFinished = false;
let wrongWriteRef = false;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function writeSlow(
  response: ServerResponse,
  chunks: string[],
  delayMs: number,
): Promise<void> {
  for (const chunk of chunks) {
    if (response.destroyed) return;
    response.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!response.destroyed) response.end();
}

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  const url = request.url ?? "";
  requests.push({
    method: request.method ?? "",
    url,
    authorization: request.headers.authorization ?? "",
    body,
  });

  if (url === "/redirect-target") {
    redirectTargetHits += 1;
    json(response, 200, { status: "ok" });
    return;
  }

  if (url === "/healthz") {
    if (healthMode === "invalid-request") {
      json(response, 400, { error: "invalid" });
      return;
    }
    if (healthMode === "redirect") {
      response.writeHead(307, { location: `${endpoint}/redirect-target` });
      response.end();
      return;
    }
    if (healthMode === "slow-body") {
      response.writeHead(200, { "content-type": "application/json" });
      void writeSlow(response, ['{"status":', '"ok"', "}"], 60);
      return;
    }
    if (healthMode === "oversized-chunked") {
      response.writeHead(200, { "content-type": "application/json" });
      response.on("close", () => {
        chunkedResponseClosed = true;
      });
      const chunk = "x".repeat(65_536);
      for (let index = 0; index < 12; index += 1) {
        if (response.destroyed) break;
        chunkedWritesAttempted += 1;
        response.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!response.destroyed) response.end();
      return;
    }
    response.writeHead(200, { "content-type": healthContentType });
    response.end(
      JSON.stringify(healthMode === "malformed" ? { status: "ok", extra: true } : { status: "ok" }),
    );
    return;
  }

  if (request.method === "PUT" && url.startsWith("/v1/secrets/")) {
    if (transientWriteFailures > 0) {
      transientWriteFailures -= 1;
      json(response, 503, { error: "temporary" });
      return;
    }
    const parsed = JSON.parse(body) as { material: string };
    stored.set(url, parsed.material);
    json(response, 200, {
      ref: wrongWriteRef
        ? "vault:other-shop:asset:wrong"
        : `vault:${url.slice("/v1/secrets/".length).replaceAll("/", ":")}`,
    });
    return;
  }

  if (request.method === "GET" && url.startsWith("/v1/secrets/")) {
    const material = stored.get(url);
    if (material === undefined) {
      json(response, 404, { error: "missing" });
      return;
    }
    json(response, 200, { material });
    return;
  }

  if (request.method === "DELETE" && url.startsWith("/v1/secrets/")) {
    if (deleteReturnsMissing) {
      response.writeHead(404, { "content-type": "application/json" });
      await writeSlow(response, ['{"error":', '"missing"', "}"], 15);
      deleteBodyFinished = true;
      return;
    }
    stored.delete(url);
    response.writeHead(204).end();
    return;
  }

  json(response, 404, { error: "unknown" });
});

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  port = address.port;
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  requests.length = 0;
  stored.clear();
  transientWriteFailures = 0;
  healthMode = "normal";
  healthContentType = "application/json";
  redirectTargetHits = 0;
  chunkedWritesAttempted = 0;
  chunkedResponseClosed = false;
  deleteReturnsMissing = false;
  deleteBodyFinished = false;
  wrongWriteRef = false;
});

function testVault(overrides: Record<string, unknown> = {}) {
  return createExternalVault({
    endpoint,
    token: VAULT_TOKEN,
    namespace: "shop-staging",
    timeoutMs: 500,
    maxAttempts: 1,
    testTransport: { allowInsecureLoopback: true },
    egressPolicy: {
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [port],
      allowedCidrs: ["127.0.0.0/8"],
    },
    ...overrides,
  });
}

describe("external vault adapter (T136 reopened RED)", () => {
  it("fails closed on missing startup configuration and production HTTP", () => {
    expect(() => createVault({ driver: "external" })).toThrow(VaultConfigError);
    expect(() =>
      createExternalVault({
        endpoint,
        token: VAULT_TOKEN,
        namespace: "shop-staging",
        egressPolicy: {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
          allowedCidrs: ["127.0.0.0/8"],
        },
      }),
    ).toThrow(ExternalVaultError);
  });

  it("rejects endpoint credentials, query, and fragment", () => {
    for (const unsafe of [
      `https://user:pass@vault.example`,
      `https://vault.example?token=leak`,
      `https://vault.example#fragment`,
    ]) {
      expect(() =>
        createExternalVault({
          endpoint: unsafe,
          token: VAULT_TOKEN,
          egressPolicy: {
            allowedHosts: ["vault.example"],
            allowedPorts: [443],
            allowedCidrs: ["10.0.0.0/8"],
          },
        }),
      ).toThrow(ExternalVaultError);
    }
  });

  it("uses authenticated namespaced refs and supports health/write/reveal/delete", async () => {
    const vault = testVault();
    await vault.health?.();
    const ref = await vault.write("ACCOUNT:credential", {
      namespace: "capability",
      idempotencyKey: "handoff-1",
    });
    expect(ref).toBe("vault:shop-staging:capability:handoff-1");
    expect(await vault.reveal(ref)).toBe("ACCOUNT:credential");
    await vault.delete(ref);
    await expect(vault.reveal(ref)).rejects.toBeInstanceOf(ExternalVaultError);
    expect(requests.every((request) => request.authorization === `Bearer ${VAULT_TOKEN}`)).toBe(
      true,
    );
  });

  it("keeps the timeout alive through a slow-drip response body", async () => {
    healthMode = "slow-body";
    const vault = testVault({ timeoutMs: 40 });
    const startedAt = Date.now();
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  it("aborts an oversized chunked body before the provider finishes sending it", async () => {
    healthMode = "oversized-chunked";
    const vault = testVault();
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunkedResponseClosed).toBe(true);
    expect(chunkedWritesAttempted).toBeLessThan(12);
  });

  it("measures the one serialized UTF-8 request body and round-trips exact-max escaped material", async () => {
    const vault = testVault({ timeoutMs: 2_000 });
    const material = "\u0000".repeat(MAX_MATERIAL_BYTES);
    const ref = await vault.write(material, {
      namespace: "asset",
      idempotencyKey: "escaped-max",
    });
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.body).toBe(JSON.stringify({ material }));
    expect(await vault.reveal(ref)).toBe(material);

    requests.length = 0;
    await expect(vault.write(`${material}x`)).rejects.toBeInstanceOf(ExternalVaultError);
    expect(requests).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify({ material }), "utf8")).toBeLessThanOrEqual(
      MAX_JSON_ENVELOPE_BYTES,
    );
  });

  it("does not follow redirects or forward the bearer/body to a redirect target", async () => {
    healthMode = "redirect";
    const vault = testVault();
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
    expect(redirectTargetHits).toBe(0);
  });

  it("enforces host, port, mixed-address, and re-resolution egress policy", async () => {
    let resolution = 0;
    const vault = createExternalVault({
      endpoint: `http://localhost:${port}`,
      token: VAULT_TOKEN,
      namespace: "shop-staging",
      timeoutMs: 500,
      maxAttempts: 1,
      testTransport: {
        allowInsecureLoopback: true,
        resolveHost: async () => {
          resolution += 1;
          return resolution === 1
            ? [{ address: "127.0.0.1", family: 4 }]
            : [{ address: "169.254.169.254", family: 4 }];
        },
      },
      egressPolicy: {
        allowedHosts: ["localhost"],
        allowedPorts: [port],
        allowedCidrs: ["127.0.0.0/8"],
      },
    });
    await vault.health?.();
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);

    const mixed = createExternalVault({
      endpoint: `http://localhost:${port}`,
      token: VAULT_TOKEN,
      testTransport: {
        allowInsecureLoopback: true,
        resolveHost: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      },
      egressPolicy: {
        allowedHosts: ["localhost"],
        allowedPorts: [port],
        allowedCidrs: ["127.0.0.0/8"],
      },
    });
    await expect(mixed.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
  });

  it("consumes strict idempotent DELETE 404 bodies before returning", async () => {
    const vault = testVault();
    deleteReturnsMissing = true;
    await vault.delete("vault:shop-staging:asset:missing");
    expect(deleteBodyFinished).toBe(true);
  });

  it("rejects wrong refs, malformed success, and wrong content type", async () => {
    const vault = testVault();
    wrongWriteRef = true;
    await expect(
      vault.write("material", { namespace: "asset", idempotencyKey: "wrong-ref" }),
    ).rejects.toBeInstanceOf(ExternalVaultError);

    healthMode = "malformed";
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
    healthMode = "normal";
    healthContentType = "text/plain";
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
  });

  it("retries an idempotent write and redacts provider details", async () => {
    transientWriteFailures = 1;
    const vault = testVault({ maxAttempts: 2 });
    const ref = await vault.write("retry-material", {
      namespace: "asset",
      idempotencyKey: "asset-1",
    });
    expect(ref).toBe("vault:shop-staging:asset:asset-1");
    expect(
      requests.filter(
        (request) => request.method === "PUT" && request.url.endsWith("/asset/asset-1"),
      ),
    ).toHaveLength(2);

    healthMode = "slow-body";
    const error = await testVault({ timeoutMs: 40 })
      .health?.()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalVaultError);
    expect(String(error)).not.toContain(VAULT_TOKEN);
    expect(String(error)).not.toContain(endpoint);
  });

  it("does not retry a strict non-transient provider rejection", async () => {
    healthMode = "invalid-request";
    const vault = testVault({ maxAttempts: 3 });
    await expect(vault.health?.()).rejects.toBeInstanceOf(ExternalVaultError);
    expect(requests.filter((request) => request.url === "/healthz")).toHaveLength(1);
  });

  it("rejects a ref from another namespace before provider access", async () => {
    const vault = testVault();
    await expect(vault.reveal("vault:other-shop:asset:asset-1")).rejects.toBeInstanceOf(
      ExternalVaultError,
    );
    expect(requests).toHaveLength(0);
  });
});
