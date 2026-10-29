import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { SUPPLIER_CAPABILITIES, type SupplierCapability, type SupplierProvider } from "./port.js";
import { createHttpSupplierPort, type HttpSupplierProvider } from "./adapters/http.js";
import { createQcstSupplierPort } from "./adapters/qcst.js";
import { createSandboxSupplierAdapter, type SandboxMode } from "./adapters/primary.js";
import { createVokhongSupplierPort } from "./adapters/vokhong.js";
import type { SupplierPort } from "./port.js";
import { z } from "zod";

const CAPABILITY_SET = new Set<string>(SUPPLIER_CAPABILITIES);
const SUPPORTED_ADAPTERS = ["qcst", "vokhong", "http", "fixture", "sandbox"] as const;
type SupportedAdapter = (typeof SUPPORTED_ADAPTERS)[number];

const TimeoutPolicySchema = z
  .object({
    autoFailover: z.boolean().optional(),
    timeoutMs: z.number().int().min(10).max(30_000).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
  })
  .strict();

const SupplierRowSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    adapter_type: z.enum(SUPPORTED_ADAPTERS),
    credential_vault_ref: z.string().regex(/^vault:\S{1,512}$/u),
    status: z.string().trim().min(1).max(32),
    timeout_policy: TimeoutPolicySchema,
    base_url: z.string().trim().min(1).max(2_048).nullable(),
    provider_capabilities: z
      .array(z.string().trim().min(1).max(64))
      .superRefine((items, context) => {
        const seen = new Set<string>();
        for (const item of items) {
          if (!CAPABILITY_SET.has(item)) {
            context.addIssue({ code: "custom", message: "unknown supplier capability" });
          }
          if (seen.has(item)) {
            context.addIssue({ code: "custom", message: "duplicate supplier capability" });
          }
          seen.add(item);
        }
      }),
    version: z.number().int().safe().min(1).max(2_147_483_647),
  })
  .strict();
type SupplierRow = z.infer<typeof SupplierRowSchema>;

export type SupplierRowLoader = (supplierId: string) => Promise<unknown | null>;

type TestTransport = {
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<readonly string[]>;
};

export interface SupplierResolverOptions {
  loadRow?: SupplierRowLoader;
  timeoutMs?: number;
  maxAttempts?: number;
  allowFixtureAdapters?: boolean;
  sandboxMode?: SandboxMode;
  testTransport?: TestTransport;
}

export interface SupplierProviderResolver {
  resolve(supplierId: string): Promise<SupplierProvider | null>;
  clear(): void;
}

const ADAPTER_CAPABILITIES: Record<SupportedAdapter, readonly SupplierCapability[]> = {
  qcst: [
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
  vokhong: ["HEALTH_READ"],
  http: ["ORDER_CREATE", "ORDER_READ", "ORDER_LIST", "CANCEL", "REFUND", "DELIVERY_PAYLOAD"],
  fixture: ["ORDER_CREATE", "ORDER_READ", "ORDER_LIST", "CANCEL", "REFUND", "DELIVERY_PAYLOAD"],
  sandbox: ["ORDER_CREATE", "ORDER_READ", "ORDER_LIST", "CANCEL", "REFUND", "DELIVERY_PAYLOAD"],
};

function defaultLoader(db: Db): SupplierRowLoader {
  return async (supplierId) => {
    const result = await sql<unknown>`
      select id, name, adapter_type, credential_vault_ref, status, timeout_policy,
             base_url, provider_capabilities, version
      from supplier
      where id = ${supplierId}
      limit 1
    `.execute(db);
    return result.rows[0] ?? null;
  };
}

function sameCapabilities(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  if (actual.size !== expected.length) return false;
  return expected.every((capability) => actual.has(capability));
}

function providerWithCapabilities(
  adapter: SupplierPort,
  adapterType: "fixture" | "sandbox",
): SupplierProvider {
  return {
    ...adapter,
    providerKey: adapterType,
    displayName: adapterType === "fixture" ? "Fixture Supplier" : "Sandbox Supplier",
    capabilities: new Set<SupplierCapability>(ADAPTER_CAPABILITIES[adapterType]),
  };
}

function buildProvider(
  row: SupplierRow,
  vault: Vault,
  options: SupplierResolverOptions,
): SupplierProvider {
  const timeoutMs = row.timeout_policy.timeoutMs ?? options.timeoutMs ?? 8_000;
  const maxAttempts = row.timeout_policy.maxAttempts ?? options.maxAttempts ?? 2;
  const transport = options.testTransport;
  const common = {
    timeoutMs,
    ...(transport ? { testTransport: transport } : {}),
  };
  switch (row.adapter_type) {
    case "qcst":
      return createQcstSupplierPort({
        baseUrl: row.base_url ?? "",
        apiKeyVaultRef: row.credential_vault_ref,
        vault,
        providerKey: row.id,
        ...common,
      });
    case "vokhong":
      return createVokhongSupplierPort({
        baseUrl: row.base_url ?? "",
        apiKeyVaultRef: row.credential_vault_ref,
        vault,
        ...common,
      });
    case "http":
      return createHttpSupplierPort({
        baseUrl: row.base_url ?? "",
        credentialVaultRef: row.credential_vault_ref,
        vault,
        timeoutMs,
        maxAttempts,
        ...(transport ? { testTransport: transport } : {}),
      });
    case "fixture":
    case "sandbox":
      return providerWithCapabilities(
        createSandboxSupplierAdapter({ mode: options.sandboxMode ?? "fulfill", vault }),
        row.adapter_type,
      );
  }
}

function validateRow(input: unknown, supplierId: string): SupplierRow | null {
  const parsed = SupplierRowSchema.safeParse(input);
  if (!parsed.success || parsed.data.id !== supplierId || parsed.data.status !== "ACTIVE")
    return null;
  if (
    !sameCapabilities(
      new Set(parsed.data.provider_capabilities),
      ADAPTER_CAPABILITIES[parsed.data.adapter_type],
    )
  ) {
    return null;
  }
  return parsed.data;
}

function fingerprint(row: SupplierRow): string {
  return JSON.stringify(row);
}

export function createSupplierProviderResolver(
  db: Db,
  vault: Vault,
  options: SupplierResolverOptions = {},
): SupplierProviderResolver {
  const loadRow = options.loadRow ?? defaultLoader(db);
  const cache = new Map<string, { fingerprint: string; provider: SupplierProvider }>();
  return {
    async resolve(supplierId) {
      if (!/^\S{1,200}$/u.test(supplierId)) return null;
      try {
        const row = validateRow(await loadRow(supplierId), supplierId);
        if (!row) {
          cache.delete(supplierId);
          return null;
        }
        if (
          (row.adapter_type === "fixture" || row.adapter_type === "sandbox") &&
          options.allowFixtureAdapters !== true
        ) {
          cache.delete(supplierId);
          return null;
        }
        const currentFingerprint = fingerprint(row);
        const cached = cache.get(supplierId);
        if (cached?.fingerprint === currentFingerprint) return cached.provider;
        const provider: SupplierProvider = {
          ...buildProvider(row, vault, options),
          providerKey: row.id,
        };
        if (!sameCapabilities(provider.capabilities, ADAPTER_CAPABILITIES[row.adapter_type])) {
          cache.delete(supplierId);
          return null;
        }
        cache.set(supplierId, { fingerprint: currentFingerprint, provider });
        return provider;
      } catch {
        cache.delete(supplierId);
        return null;
      }
    },
    clear() {
      cache.clear();
    },
  };
}

export async function resolveSupplierProvider(
  db: Db,
  supplierId: string,
  vault: Vault,
  options: SupplierResolverOptions = {},
): Promise<SupplierProvider | null> {
  return createSupplierProviderResolver(db, vault, options).resolve(supplierId);
}

export { SupplierRowSchema };
export type { HttpSupplierProvider };
