import { describe, expect, it } from "vitest";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import {
  createSupplierProviderResolver,
  type SupplierResolverOptions,
  type SupplierRowLoader,
} from "../../src/modules/supplier/resolver.js";
import {
  checkSupplierProviderReadiness,
  type SupplierPurchaseProvider,
} from "../../src/modules/supplier/readiness.js";

const CAPABILITIES = [
  "ORDER_CREATE",
  "ORDER_READ",
  "ORDER_LIST",
  "CANCEL",
  "REFUND",
  "DELIVERY_PAYLOAD",
] as const;
const QCST_CAPABILITIES = [
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
] as const;

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "http",
    name: "Supplier",
    adapter_type: "http",
    credential_vault_ref: "vault:test:supplier",
    status: "ACTIVE",
    timeout_policy: { autoFailover: false },
    base_url: "https://supplier.example",
    provider_capabilities: [...CAPABILITIES],
    version: 1,
    ...overrides,
  };
}

function resolver(loader: SupplierRowLoader, options: SupplierResolverOptions = {}) {
  return createSupplierProviderResolver({} as Db, createInMemoryVault(), {
    ...options,
    loadRow: loader,
  });
}

describe("supplier runtime provider resolver", () => {
  it("resolves an active supported row and rereads the database while reusing a validated fingerprint", async () => {
    let reads = 0;
    const providerResolver = resolver(async () => {
      reads += 1;
      return row();
    });
    const first = await providerResolver.resolve("http");
    const second = await providerResolver.resolve("http");
    expect(first?.providerKey).toBe("http");
    expect(second).toBe(first);
    expect(reads).toBe(2);
  });

  it("rejects inactive, unknown, malformed, and mismatched rows", async () => {
    const cases = [
      row({ status: "DISABLED" }),
      { ...row(), unexpected: true },
      row({ provider_capabilities: ["ORDER_CREATE", "ORDER_CREATE"] }),
      row({ provider_capabilities: ["NOT_A_CAPABILITY"] }),
      row({ id: "supplier-2" }),
      row({ credential_vault_ref: "plaintext" }),
      row({ base_url: null }),
      null,
    ];
    for (const candidate of cases) {
      await expect(resolver(async () => candidate).resolve("http")).resolves.toBeNull();
    }
  });
  it("binds runtime identity to an opaque persisted supplier ID", async () => {
    const supplierId = "supplier-opaque-01";
    const provider = await resolver(async () => row({ id: supplierId })).resolve(supplierId);
    expect(provider?.providerKey).toBe(supplierId);
  });

  it("fails closed before probing a provider with missing or mismatched persisted identity", async () => {
    let healthCalls = 0;
    let availabilityCalls = 0;
    const providerBase = {
      capabilities: new Set(["HEALTH_READ"]),
      health: async () => {
        healthCalls += 1;
        return { ready: true, service: null };
      },
      getAvailability: async () => {
        availabilityCalls += 1;
        return { status: "AVAILABLE", observedAt: "2026-10-27T00:00:00.000Z", quantity: 1 };
      },
    };
    for (const providerKey of [undefined, "other-supplier"]) {
      const provider = {
        ...providerBase,
        ...(providerKey === undefined ? {} : { providerKey }),
      } as unknown as SupplierPurchaseProvider;
      await expect(
        checkSupplierProviderReadiness(provider, {
          supplierId: "persisted-supplier",
          supplierSku: "SKU-1",
          region: null,
        }),
      ).resolves.toEqual({ ok: false, reason: "SUPPLIER_UNAVAILABLE" });
    }
    expect(healthCalls).toBe(0);
    expect(availabilityCalls).toBe(0);
  });

  it("rejects unsupported adapter types and capability mismatches", async () => {
    await expect(
      resolver(async () => row({ adapter_type: "unsupported" })).resolve("http"),
    ).resolves.toBeNull();
    await expect(
      resolver(async () => row({ provider_capabilities: ["ORDER_CREATE"] })).resolve("http"),
    ).resolves.toBeNull();
  });

  it("refreshes the cached provider when the validated row version changes", async () => {
    let current: Record<string, unknown> = row();
    const providerResolver = resolver(async () => current);
    const first = await providerResolver.resolve("http");
    current = row({ version: 2 });
    const second = await providerResolver.resolve("http");
    expect(second).not.toBe(first);
  });
  it("resolves a real QCST row using its fixed provider identity and capabilities", async () => {
    const provider = await resolver(async () =>
      row({
        id: "qcst",
        adapter_type: "qcst",
        base_url: "https://api.qcst.tech/",
        provider_capabilities: [...QCST_CAPABILITIES],
      }),
    ).resolve("qcst");
    expect(provider?.providerKey).toBe("qcst");
    expect(provider?.capabilities).toEqual(new Set(QCST_CAPABILITIES));
    expect(provider?.capabilities.has("CATALOG_LIST")).toBe(true);
  });

  it("keeps fixture and sandbox adapters closed unless explicitly enabled", async () => {
    for (const adapterType of ["fixture", "sandbox"] as const) {
      const fixtureRow = row({
        id: adapterType,
        adapter_type: adapterType,
      });
      await expect(resolver(async () => fixtureRow).resolve(adapterType)).resolves.toBeNull();
      await expect(
        resolver(async () => fixtureRow, { allowFixtureAdapters: true }).resolve(adapterType),
      ).resolves.toMatchObject({ providerKey: adapterType });
    }
  });

  it("clears cached providers when the persisted row is disabled or deleted", async () => {
    let current: Record<string, unknown> | null = row();
    const providerResolver = resolver(async () => current);
    const first = await providerResolver.resolve("http");
    expect(first).not.toBeNull();

    current = row({ status: "DISABLED" });
    await expect(providerResolver.resolve("http")).resolves.toBeNull();
    current = null;
    await expect(providerResolver.resolve("http")).resolves.toBeNull();

    current = row();
    const replacement = await providerResolver.resolve("http");
    expect(replacement).not.toBe(first);
  });

  it("resolves HTTP credentials from Vault only when making a request", async () => {
    let reveals = 0;
    const testCredential = "test-only-supplier-auth-value";
    const vault = {
      ...createInMemoryVault(),
      async reveal(ref: string): Promise<string> {
        reveals += 1;
        expect(ref).toBe("vault:test:supplier");
        return testCredential;
      },
    };
    const providerResolver = createSupplierProviderResolver({} as Db, vault, {
      loadRow: async () => row({ base_url: "http://127.0.0.1" }),
      testTransport: {
        allowInsecureLoopback: true,
        resolve: async () => ["127.0.0.1"],
        fetch: async (_input, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${testCredential}`);
          return new Response(
            JSON.stringify({ status: "AVAILABLE", observedAt: "2026-10-20T00:00:00.000Z" }),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    const provider = await providerResolver.resolve("http");
    expect(reveals).toBe(0);
    await provider?.getAvailability({ supplierSku: "SKU-1" });
    expect(reveals).toBe(1);
  });
});
