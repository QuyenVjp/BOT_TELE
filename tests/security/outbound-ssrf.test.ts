import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  assertOutboundTargetAllowed,
  classifyAddress,
  OutboundPolicyError,
  parseOutboundUrl,
  type AddressClass,
  type OutboundPolicyCode,
} from "../../src/infrastructure/net/outbound-policy.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createHttpSupplierPort } from "../../src/modules/supplier/adapters/http.js";
import { SupplierPortError } from "../../src/modules/supplier/port.js";

/**
 * Adversarial SSRF policy tests. Every DNS lookup is injected — no real
 * resolver is touched, so the suite is deterministic and offline.
 */

const PUBLIC_IP = "93.184.216.34";
const METADATA_IP = "169.254.169.254";

async function rejectionCode(run: () => unknown): Promise<OutboundPolicyCode> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OutboundPolicyError) return error.code;
    throw error;
  }
  throw new Error("expected an OutboundPolicyError");
}

function resolveTo(...addresses: string[]): () => Promise<readonly string[]> {
  return () => Promise.resolve(addresses);
}

describe("parseOutboundUrl static validation", () => {
  it.each([
    ["not a url", "MALFORMED_URL"],
    ["//example.com/", "MALFORMED_URL"],
    ["https://example.com:99999/", "MALFORMED_URL"],
    ["ftp://example.com/", "SCHEME_NOT_ALLOWED"],
    ["http://127.0.0.1/", "SCHEME_NOT_ALLOWED"],
    ["http://example.com/", "SCHEME_NOT_ALLOWED"],
    ["https://user:pass@example.com/", "CREDENTIALS_IN_URL"],
    ["https://user@example.com/", "CREDENTIALS_IN_URL"],
    ["https://example.com/?token=leak", "QUERY_OR_HASH_NOT_ALLOWED"],
    ["https://example.com/#fragment", "QUERY_OR_HASH_NOT_ALLOWED"],
    ["https://example.com:8443/", "PORT_NOT_ALLOWED"],
    ["https://example.com:22/", "PORT_NOT_ALLOWED"],
  ])("rejects %s with %s", async (url, code) => {
    expect(await rejectionCode(() => parseOutboundUrl(url))).toBe(code);
  });

  it("accepts https on 443 and explicit allowed ports", () => {
    expect(parseOutboundUrl("https://example.com/").protocol).toBe("https:");
    expect(parseOutboundUrl("https://example.com:8443/", { allowedPorts: [8443] }).port).toBe(
      "8443",
    );
  });

  it("enforces an exact, case-insensitive host allowlist", async () => {
    const options = { allowedHosts: ["API.Example.com"] };
    expect(parseOutboundUrl("https://api.example.com/", options).hostname).toBe("api.example.com");
    expect(await rejectionCode(() => parseOutboundUrl("https://evil.example.com/", options))).toBe(
      "HOST_NOT_ALLOWED",
    );
    expect(
      await rejectionCode(() => parseOutboundUrl("https://api.example.com.evil.test/", options)),
    ).toBe("HOST_NOT_ALLOWED");
  });
});

describe("classifyAddress", () => {
  it.each([
    [PUBLIC_IP, "public"],
    ["8.8.8.8", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    [METADATA_IP, "metadata"],
    ["169.254.1.1", "link-local"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "reserved"],
    ["192.0.0.1", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["198.51.100.1", "reserved"],
    ["203.0.113.1", "reserved"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fd00::1", "private"],
    ["fc00::1", "private"],
    ["ff02::1", "multicast"],
    ["fd00:ec2::254", "metadata"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::7f00:1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["2606:4700::1111", "public"],
    ["not-an-ip", "reserved"],
  ] as Array<[string, AddressClass]>)("classifies %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("normalizes uppercase IPv6 and IPv4-mapped forms", () => {
    expect(classifyAddress("FD00::1")).toBe("private");
    expect(classifyAddress("FE80::1")).toBe("link-local");
    expect(classifyAddress("::FFFF:169.254.169.254")).toBe("metadata");
    expect(classifyAddress("::1")).toBe("loopback");
  });
});

describe("assertOutboundTargetAllowed rejects non-public literals", () => {
  it.each([
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://0.0.0.0/",
    "https://10.0.0.5/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/",
    "https://[fe80::1]/",
    "https://[fd00::1]/",
    "https://[fd00:ec2::254]/",
    "https://[::ffff:127.0.0.1]/",
    "https://2130706433/",
    "https://0177.0.0.1/",
    "https://0x7f000001/",
  ])("blocks %s with ADDRESS_NOT_ALLOWED", async (url) => {
    expect(await rejectionCode(() => assertOutboundTargetAllowed(url))).toBe("ADDRESS_NOT_ALLOWED");
  });

  it("skips DNS for literal IP hosts", async () => {
    const resolve = vi.fn(resolveTo(PUBLIC_IP));
    expect(
      await rejectionCode(() => assertOutboundTargetAllowed("https://10.0.0.5/", {}, { resolve })),
    ).toBe("ADDRESS_NOT_ALLOWED");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("assertOutboundTargetAllowed DNS classification", () => {
  it("blocks localhost resolving to loopback", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed("https://localhost/", {}, { resolve: resolveTo("127.0.0.1") }),
      ),
    ).toBe("ADDRESS_NOT_ALLOWED");
  });

  it("blocks cloud metadata reached through DNS", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://metadata.internal/",
          {},
          { resolve: resolveTo(METADATA_IP) },
        ),
      ),
    ).toBe("ADDRESS_NOT_ALLOWED");
  });

  it("blocks a public name that resolves to a private address (rebinding)", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://shop.example/",
          {},
          { resolve: resolveTo("10.0.0.5") },
        ),
      ),
    ).toBe("ADDRESS_NOT_ALLOWED");
  });

  it("blocks a mix of public and private answers even when the first is public", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://shop.example/",
          {},
          { resolve: resolveTo(PUBLIC_IP, "192.168.1.1") },
        ),
      ),
    ).toBe("ADDRESS_NOT_ALLOWED");
  });

  it("fails closed when resolution is empty or fails", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed("https://shop.example/", {}, { resolve: resolveTo() }),
      ),
    ).toBe("DNS_RESOLUTION_FAILED");
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://shop.example/",
          {},
          {
            resolve: () => Promise.reject(new Error("ENOTFOUND")),
          },
        ),
      ),
    ).toBe("DNS_RESOLUTION_FAILED");
  });

  it("accepts a public host resolving to a public address", async () => {
    const result = await assertOutboundTargetAllowed(
      "https://example.com/",
      {},
      { resolve: resolveTo(PUBLIC_IP) },
    );
    expect(result.addresses).toEqual([PUBLIC_IP]);
    expect(result.url.hostname).toBe("example.com");
  });

  it("allows a non-public address only inside an explicit CIDR allowlist", async () => {
    const allowed = await assertOutboundTargetAllowed(
      "https://internal.example/",
      { allowedCidrs: ["10.0.0.0/8"] },
      { resolve: resolveTo("10.1.2.3") },
    );
    expect(allowed.addresses).toEqual(["10.1.2.3"]);

    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://internal.example/",
          { allowedCidrs: ["10.0.0.0/8"] },
          { resolve: resolveTo("192.168.1.1") },
        ),
      ),
    ).toBe("CIDR_NOT_ALLOWED");

    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://internal.example/",
          { allowedCidrs: ["10.0.0.0/8"] },
          { resolve: resolveTo(PUBLIC_IP) },
        ),
      ),
    ).toBe("CIDR_NOT_ALLOWED");
  });

  it("matches CIDR prefixes numerically, not as strings", async () => {
    const accept = (address: string) =>
      assertOutboundTargetAllowed(
        "https://internal.example/",
        { allowedCidrs: ["192.168.0.0/24"] },
        { resolve: resolveTo(address) },
      );
    await expect(accept("192.168.0.255")).resolves.toMatchObject({
      addresses: ["192.168.0.255"],
    });
    expect(await rejectionCode(() => accept("192.168.1.0"))).toBe("CIDR_NOT_ALLOWED");
    expect(await rejectionCode(() => accept("10.0.0.0"))).toBe("CIDR_NOT_ALLOWED");
  });

  it("supports IPv6 CIDR allowlists", async () => {
    await expect(
      assertOutboundTargetAllowed(
        "https://[fd00::5]/",
        { allowedCidrs: ["fd00::/64"] },
        { resolve: resolveTo("fd00::5") },
      ),
    ).resolves.toMatchObject({ addresses: ["fd00::5"] });
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://[fd00::5]/",
          { allowedCidrs: ["fd00:1::/64"] },
          { resolve: resolveTo("fd00::5") },
        ),
      ),
    ).toBe("CIDR_NOT_ALLOWED");
  });

  it("fails closed on an invalid CIDR allowlist entry", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "https://example.com/",
          { allowedCidrs: ["10.0.0.0/99"] },
          { resolve: resolveTo(PUBLIC_IP) },
        ),
      ),
    ).toBe("CIDR_NOT_ALLOWED");
  });
});

describe("loopback test-mode escape hatch", () => {
  it("is closed by default and open only with allowInsecureLoopback", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "http://localhost:8080/",
          { allowedPorts: [8080] },
          { resolve: resolveTo("127.0.0.1") },
        ),
      ),
    ).toBe("SCHEME_NOT_ALLOWED");

    await expect(
      assertOutboundTargetAllowed(
        "http://localhost:8080/",
        { allowInsecureLoopback: true, allowedPorts: [8080] },
        { resolve: resolveTo("127.0.0.1") },
      ),
    ).resolves.toMatchObject({ addresses: ["127.0.0.1"] });

    await expect(
      assertOutboundTargetAllowed("http://127.0.0.1:8080/", {
        allowInsecureLoopback: true,
        allowedPorts: [8080],
      }),
    ).resolves.toMatchObject({ addresses: ["127.0.0.1"] });
  });

  it("still refuses non-loopback hosts and unlisted ports in test mode", async () => {
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed(
          "http://shop.example:8080/",
          { allowInsecureLoopback: true, allowedPorts: [8080] },
          { resolve: resolveTo(PUBLIC_IP) },
        ),
      ),
    ).toBe("SCHEME_NOT_ALLOWED");
    expect(
      await rejectionCode(() =>
        assertOutboundTargetAllowed("http://127.0.0.1:9090/", { allowInsecureLoopback: true }),
      ),
    ).toBe("PORT_NOT_ALLOWED");
  });
});

describe("http supplier adapter is wired to the policy", () => {
  /** Fixture material only: never a real credential, and short enough not to be secret-shaped. */
  const SUPPLIER_FIXTURE_TOKEN = "fixture-token";
  function port(baseUrl: string, overrides: Record<string, unknown> = {}) {
    return createHttpSupplierPort({
      baseUrl,
      token: SUPPLIER_FIXTURE_TOKEN,
      timeoutMs: 500,
      maxAttempts: 2,
      vault: createInMemoryVault(),
      ...overrides,
    });
  }

  it("keeps rejecting embedded credentials and non-https base URLs at construction", () => {
    expect(() => port("https://user:pass@supplier.example")).toThrow(SupplierPortError);
    expect(() => port("http://supplier.example")).toThrow(SupplierPortError);
  });

  it("blocks a base URL pointing at loopback when the test escape hatch is off", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const supplier = port("https://127.0.0.1/", { testTransport: { fetch: fetchImpl } });
    const error = await supplier.getAvailability({ supplierSku: "SKU-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(SupplierPortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a supplier host that resolves to cloud metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const supplier = port("https://supplier.example/", {
      testTransport: { fetch: fetchImpl, resolve: resolveTo(METADATA_IP) },
    });
    await expect(supplier.getAvailability({ supplierSku: "SKU-1" })).rejects.toBeInstanceOf(
      SupplierPortError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-resolves the supplier host before every attempt (rebinding)", async () => {
    let resolution = 0;
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const supplier = port("https://supplier.example/", {
      testTransport: {
        fetch: fetchImpl,
        resolve: () => {
          resolution += 1;
          return Promise.resolve(resolution === 1 ? [PUBLIC_IP] : ["127.0.0.1"]);
        },
      },
    });
    await expect(supplier.getAvailability({ supplierSku: "SKU-1" })).rejects.toBeInstanceOf(
      SupplierPortError,
    );
    expect(resolution).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still reaches loopback in explicit test mode", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "AVAILABLE", observedAt: "2026-07-18T00:00:00.000Z" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server failed to bind");
    try {
      const supplier = port(`http://127.0.0.1:${address.port}`, {
        testTransport: { allowInsecureLoopback: true },
      });
      await expect(supplier.getAvailability({ supplierSku: "SKU-1" })).resolves.toMatchObject({
        status: "AVAILABLE",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
