import type { SupplierProvider } from "./port.js";

export interface SupplierProviderRegistry {
  get(providerKey: string): SupplierProvider | null;
  list(): readonly SupplierProvider[];
}

export function createSupplierProviderRegistry(
  providers: readonly SupplierProvider[],
): SupplierProviderRegistry {
  const byKey = new Map<string, SupplierProvider>();
  for (const provider of providers) {
    const key = provider.providerKey.trim();
    if (!key || byKey.has(key)) throw new Error("SUPPLIER_PROVIDER_KEY_DUPLICATE");
    byKey.set(key, provider);
  }
  return {
    get: (providerKey) => byKey.get(providerKey.trim()) ?? null,
    list: () => [...byKey.values()],
  };
}
