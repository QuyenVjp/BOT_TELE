import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import {
  hasSupplierCapability,
  isSupplierProviderFor,
  NormalizedSupplierHealthSchema,
  parseAvailabilityResult,
  SUPPLIER_CAPABILITIES,
  type SupplierPort,
  type SupplierProvider,
} from "./port.js";

export type SupplierPurchaseProvider = SupplierPort | SupplierProvider;

interface SupplierMappingRow {
  variant_id: string;
  variant_version: number;
  supplier_id: string;
  supplier_version: number;
  supplier_sku_id: string;
  supplier_sku_version: number;
  external_sku: string;
  cost_vnd: string | number;
  region: string | null;
  supplier_status: string;
  credential_vault_ref: string;
  provider_capabilities: unknown;
  sku_active: boolean;
  primary_supplier_sku_id: string | null;
  catalog_id: string | null;
  catalog_version: number | null;
  selection_status: string | null;
  catalog_enabled: boolean | null;
  domain_status: string | null;
  is_missing: boolean | null;
  availability: string | null;
}

type SupplierReadinessFailure = {
  ok: false;
  reason: "SUPPLIER_UNAVAILABLE" | "SUPPLIER_UNSUPPORTED";
};

const SUPPLIER_READINESS_PERMIT_BRAND: unique symbol = Symbol("SupplierReadinessPermit");
export interface SupplierReadinessPermit {
  readonly [SUPPLIER_READINESS_PERMIT_BRAND]: true;
  readonly variantId: string;
  readonly variantVersion: number;
  readonly supplierId: string;
  readonly supplierVersion: number;
  readonly supplierSkuId: string;
  readonly supplierSkuVersion: number;
  readonly catalogProduct: Readonly<{ id: string; version: number }> | null;
}
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSupplierReadinessPermit(value: unknown): value is SupplierReadinessPermit {
  try {
    if (
      !isRecord(value) ||
      !Object.isFrozen(value) ||
      value[SUPPLIER_READINESS_PERMIT_BRAND] !== true ||
      typeof value.variantId !== "string" ||
      value.variantId.length === 0 ||
      !isVersion(value.variantVersion) ||
      typeof value.supplierId !== "string" ||
      value.supplierId.length === 0 ||
      !isVersion(value.supplierVersion) ||
      typeof value.supplierSkuId !== "string" ||
      value.supplierSkuId.length === 0 ||
      !isVersion(value.supplierSkuVersion)
    ) {
      return false;
    }
    const catalogProduct = value.catalogProduct;
    return (
      catalogProduct === null ||
      (isRecord(catalogProduct) &&
        Object.isFrozen(catalogProduct) &&
        typeof catalogProduct.id === "string" &&
        catalogProduct.id.length > 0 &&
        isVersion(catalogProduct.version))
    );
  } catch {
    return false;
  }
}

export type SupplierPurchaseReadiness =
  | { ok: true; externalSku: string; costVnd: number; region: string | null }
  | SupplierReadinessFailure;
export type SupplierReadinessResult =
  { ok: true; permit: SupplierReadinessPermit } | SupplierReadinessFailure;
export type SupplierReadinessChecker = (variantId: string) => Promise<SupplierReadinessResult>;

export interface SupplierProviderResolverLike {
  resolve(supplierId: string): Promise<SupplierPurchaseProvider | null>;
}

export async function checkSelectedSupplierReadiness(
  exec: Executor,
  input: {
    variantId: string;
    providerResolver: SupplierProviderResolverLike;
    purchaseEnabled: boolean;
  },
): Promise<SupplierReadinessResult> {
  const row = await readSupplierMappingRow(exec, { variantId: input.variantId });
  if (!row) return unavailable("SUPPLIER_UNAVAILABLE");
  const provider = await input.providerResolver.resolve(row.supplier_id);
  if (!provider) return unavailable("SUPPLIER_UNAVAILABLE");
  const mapping = evaluateMapping(row, provider, input.purchaseEnabled);
  if (!mapping.ok) return mapping;
  if (!isSupplierProviderFor(provider, row.supplier_id)) {
    return unavailable("SUPPLIER_UNAVAILABLE");
  }
  const providerReadiness = await checkSupplierProviderReadiness(provider, {
    supplierId: row.supplier_id,
    supplierSku: mapping.externalSku,
    region: mapping.region,
  });
  if (!providerReadiness.ok) return providerReadiness;
  const permit = permitForMapping(row);
  return permit ? { ok: true, permit } : unavailable("SUPPLIER_UNAVAILABLE");
}

function storedCapability(capabilities: unknown, capability: string): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability);
}
function persistedCapabilitiesValid(capabilities: unknown): boolean {
  if (!Array.isArray(capabilities)) return false;
  const seen: string[] = [];
  for (const capability of capabilities) {
    if (
      typeof capability !== "string" ||
      !SUPPLIER_CAPABILITIES.some((known) => known === capability) ||
      seen.includes(capability)
    ) {
      return false;
    }
    seen.push(capability);
  }
  return true;
}

function runtimeCapabilitiesMatchPersisted(
  provider: SupplierPurchaseProvider,
  row: SupplierMappingRow,
): boolean {
  if (!("capabilities" in provider)) return true;
  if (!(provider.capabilities instanceof Set)) return false;
  for (const capability of SUPPLIER_CAPABILITIES) {
    if (
      storedCapability(row.provider_capabilities, capability) &&
      !hasSupplierCapability(provider, capability)
    ) {
      return false;
    }
  }
  return true;
}

function runtimeHasCapability(
  provider: SupplierPurchaseProvider,
  capability: (typeof SUPPLIER_CAPABILITIES)[number],
): boolean {
  if (!("capabilities" in provider)) return true;
  return provider.capabilities instanceof Set && hasSupplierCapability(provider, capability);
}

function catalogManaged(row: SupplierMappingRow, provider: SupplierPurchaseProvider): boolean {
  return (
    storedCapability(row.provider_capabilities, "CATALOG_LIST") &&
    runtimeHasCapability(provider, "CATALOG_LIST")
  );
}

function orderCreationSupported(
  row: SupplierMappingRow,
  provider: SupplierPurchaseProvider,
): boolean {
  return (
    storedCapability(row.provider_capabilities, "ORDER_CREATE") &&
    storedCapability(row.provider_capabilities, "DELIVERY_PAYLOAD") &&
    runtimeHasCapability(provider, "ORDER_CREATE") &&
    runtimeHasCapability(provider, "DELIVERY_PAYLOAD")
  );
}

function unavailable(reason: SupplierReadinessFailure["reason"]): SupplierReadinessFailure {
  return { ok: false, reason };
}

function providerUnavailable(): { ok: false; reason: "SUPPLIER_UNAVAILABLE" } {
  return { ok: false, reason: "SUPPLIER_UNAVAILABLE" };
}

function permitForMapping(row: SupplierMappingRow): SupplierReadinessPermit | null {
  let catalogProduct: SupplierReadinessPermit["catalogProduct"] = null;
  if (row.catalog_id !== null && row.catalog_version !== null) {
    catalogProduct = Object.freeze({ id: row.catalog_id, version: row.catalog_version });
  } else if (row.catalog_id !== null || row.catalog_version !== null) {
    return null;
  }
  const permit: SupplierReadinessPermit = {
    [SUPPLIER_READINESS_PERMIT_BRAND]: true,
    variantId: row.variant_id,
    variantVersion: row.variant_version,
    supplierId: row.supplier_id,
    supplierVersion: row.supplier_version,
    supplierSkuId: row.supplier_sku_id,
    supplierSkuVersion: row.supplier_sku_version,
    catalogProduct,
  };
  return Object.freeze(permit);
}

function evaluateMapping(
  row: SupplierMappingRow,
  provider: SupplierPurchaseProvider,
  purchaseEnabled: boolean,
): SupplierPurchaseReadiness {
  if (!persistedCapabilitiesValid(row.provider_capabilities)) {
    return unavailable("SUPPLIER_UNSUPPORTED");
  }
  if (!runtimeCapabilitiesMatchPersisted(provider, row)) {
    return unavailable("SUPPLIER_UNSUPPORTED");
  }
  if (purchaseEnabled !== true || !orderCreationSupported(row, provider)) {
    return unavailable("SUPPLIER_UNSUPPORTED");
  }
  if (
    row.supplier_status !== "ACTIVE" ||
    !/^vault:\S{1,512}$/u.test(row.credential_vault_ref) ||
    !row.external_sku.trim() ||
    !row.sku_active ||
    row.primary_supplier_sku_id !== row.supplier_sku_id
  ) {
    return unavailable("SUPPLIER_UNAVAILABLE");
  }
  if (catalogManaged(row, provider)) {
    if (
      !row.catalog_id ||
      row.selection_status !== "SELECTED" ||
      row.catalog_enabled !== true ||
      row.domain_status !== "SUPPORTED" ||
      row.is_missing !== false ||
      !["AVAILABLE", "LOW"].includes(row.availability ?? "")
    ) {
      return unavailable("SUPPLIER_UNAVAILABLE");
    }
  }
  const costVnd = Number(row.cost_vnd);
  if (!Number.isSafeInteger(costVnd) || costVnd < 0) {
    return unavailable("SUPPLIER_UNAVAILABLE");
  }
  return { ok: true, externalSku: row.external_sku, costVnd, region: row.region };
}

async function readSupplierMappingRow(
  exec: Executor,
  input: {
    variantId: string;
    supplierId?: string;
    supplierSkuId?: string;
  },
): Promise<SupplierMappingRow | null> {
  const supplierIdPredicate =
    input.supplierId === undefined ? sql`` : sql`and s.id = ${input.supplierId}`;
  const supplierSkuIdPredicate =
    input.supplierSkuId === undefined ? sql`` : sql`and ss.id = ${input.supplierSkuId}`;
  const result = await sql<SupplierMappingRow>`
    select
      v.id as variant_id,
      v.version as variant_version,
      s.id as supplier_id,
      s.version as supplier_version,
      ss.id as supplier_sku_id,
      ss.version as supplier_sku_version,
      ss.external_sku,
      ss.cost_vnd,
      ss.region,
      s.status as supplier_status,
      s.credential_vault_ref,
      s.provider_capabilities,
      ss.is_active as sku_active,
      v.supplier_sku_id as primary_supplier_sku_id,
      cp.id as catalog_id,
      cp.version as catalog_version,
      cp.selection_status,
      cp.is_enabled as catalog_enabled,
      cp.domain_status,
      cp.is_missing,
      cp.availability
    from product_variant v
    join supplier_sku ss
      on ss.id = v.supplier_sku_id and ss.variant_id = v.id
    join supplier s on s.id = ss.supplier_id
    left join supplier_catalog_product cp
      on cp.supplier_id = s.id and cp.supplier_sku_id = ss.id
    where v.id = ${input.variantId}
      ${supplierIdPredicate}
      ${supplierSkuIdPredicate}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

/**
 * Read and validate only the persisted supplier mapping. This function MUST
 * remain database-only so it is safe to call while the purchase claim holds
 * order and supplier-order row locks.
 */
async function readSupplierMapping(
  exec: Executor,
  input: {
    variantId: string;
    supplierId: string;
    supplierSkuId: string;
    provider: SupplierPurchaseProvider;
    purchaseEnabled: boolean;
  },
): Promise<SupplierPurchaseReadiness> {
  const row = await readSupplierMappingRow(exec, input);
  if (!row) return unavailable("SUPPLIER_UNAVAILABLE");
  return evaluateMapping(row, input.provider, input.purchaseEnabled);
}

/**
 * Revalidate the selected supplier mapping inside a caller transaction. This
 * helper performs only database reads and keeps its row locks until commit.
 */
export async function lockAndVerifySupplierReadinessPermit(
  exec: Executor,
  permit: SupplierReadinessPermit,
): Promise<boolean> {
  if (!isSupplierReadinessPermit(permit)) return false;
  const catalogIdPredicate =
    permit.catalogProduct === null ? sql`` : sql`and id = ${permit.catalogProduct.id}`;
  const catalog = await sql<{ id: string; version: number }>`
    select id, version
    from supplier_catalog_product
    where supplier_id = ${permit.supplierId}
      and supplier_sku_id = ${permit.supplierSkuId}
      ${catalogIdPredicate}
    for share
  `.execute(exec);
  if (permit.catalogProduct === null) {
    if (catalog.rows.length !== 0) return false;
  } else {
    const catalogRow = catalog.rows[0];
    if (
      catalog.rows.length !== 1 ||
      catalogRow === undefined ||
      catalogRow.id !== permit.catalogProduct.id ||
      catalogRow.version !== permit.catalogProduct.version
    ) {
      return false;
    }
  }
  const selected = await sql<{
    variant_id: string;
    variant_version: number;
    selected_supplier_sku_id: string | null;
    supplier_id: string;
    supplier_version: number;
    supplier_sku_id: string;
    supplier_sku_version: number;
  }>`
    select
      v.id as variant_id,
      v.version as variant_version,
      v.supplier_sku_id as selected_supplier_sku_id,
      s.id as supplier_id,
      s.version as supplier_version,
      ss.id as supplier_sku_id,
      ss.version as supplier_sku_version
    from product_variant v
    join supplier_sku ss on ss.id = v.supplier_sku_id and ss.variant_id = v.id
    join supplier s on s.id = ss.supplier_id
    where v.id = ${permit.variantId}
    for share of v, ss, s
  `.execute(exec);
  const row = selected.rows[0];
  return (
    row !== undefined &&
    row.variant_id === permit.variantId &&
    row.variant_version === permit.variantVersion &&
    row.selected_supplier_sku_id === permit.supplierSkuId &&
    row.supplier_id === permit.supplierId &&
    row.supplier_version === permit.supplierVersion &&
    row.supplier_sku_id === permit.supplierSkuId &&
    row.supplier_sku_version === permit.supplierSkuVersion
  );
}

/**
 * Probe a configured adapter without exposing provider error details. A
 * provider advertising HEALTH_READ must implement health and return the
 * normalized schema; providers without that capability still require the
 * selected-SKU availability probe.
 */
export async function checkSupplierProviderHealth(
  provider: SupplierPurchaseProvider,
): Promise<boolean> {
  if (!("capabilities" in provider)) return true;
  if (!(provider.capabilities instanceof Set)) return false;
  const requiresHealth = hasSupplierCapability(provider, "HEALTH_READ");
  if (!requiresHealth && typeof provider.health !== "function") return true;
  if (typeof provider.health !== "function") return false;
  try {
    const parsed = NormalizedSupplierHealthSchema.safeParse(await provider.health());
    return parsed.success && parsed.data.ready === true;
  } catch {
    return false;
  }
}

export async function checkSupplierProviderReadiness(
  provider: SupplierPurchaseProvider,
  input: { supplierId: string; supplierSku: string; region: string | null },
): Promise<{ ok: true } | { ok: false; reason: "SUPPLIER_UNAVAILABLE" }> {
  if (!isSupplierProviderFor(provider, input.supplierId)) {
    return providerUnavailable();
  }
  if (!(await checkSupplierProviderHealth(provider))) {
    return providerUnavailable();
  }
  try {
    const availability = parseAvailabilityResult(
      await provider.getAvailability({
        supplierSku: input.supplierSku,
        ...(input.region === null ? {} : { region: input.region }),
      }),
    );
    if (
      availability.quantity === 0 &&
      "capabilities" in provider &&
      provider.capabilities instanceof Set &&
      hasSupplierCapability(provider, "STOCK_QUANTITY")
    ) {
      return providerUnavailable();
    }
    return availability.status === "AVAILABLE" || availability.status === "LOW"
      ? { ok: true }
      : providerUnavailable();
  } catch {
    return providerUnavailable();
  }
}

export async function checkSupplierPurchaseReadiness(
  exec: Executor,
  input: {
    variantId: string;
    supplierId: string;
    supplierSkuId: string;
    provider: SupplierPurchaseProvider;
    purchaseEnabled: boolean;
    mappingOnly?: boolean;
  },
): Promise<SupplierPurchaseReadiness> {
  const readiness = await readSupplierMapping(exec, input);
  if (!readiness.ok) return readiness;
  if (!isSupplierProviderFor(input.provider, input.supplierId)) {
    return unavailable("SUPPLIER_UNAVAILABLE");
  }
  if (input.mappingOnly === true) return readiness;
  const providerReadiness = await checkSupplierProviderReadiness(input.provider, {
    supplierId: input.supplierId,
    supplierSku: readiness.externalSku,
    region: readiness.region,
  });
  return providerReadiness.ok ? readiness : providerReadiness;
}
