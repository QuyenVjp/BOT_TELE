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
    if (!provider.providerKey.trim() || byKey.has(provider.providerKey)) {
      throw new Error("SUPPLIER_PROVIDER_DUPLICATE");
    }
    byKey.set(provider.providerKey, provider);
  }
  return {
    get(providerKey) {
      return byKey.get(providerKey) ?? null;
    },
    list() {
      return providers;
    },
  };
}
