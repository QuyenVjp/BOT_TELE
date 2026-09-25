import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { hasSupplierCapability, type SupplierPort, type SupplierProvider } from "./port.js";

export type SupplierPurchaseProvider = SupplierPort | SupplierProvider;

interface SupplierMappingRow {
  supplier_id: string;
  supplier_sku_id: string;
  external_sku: string;
  cost_vnd: string | number;
  region: string | null;
  supplier_status: string;
  provider_capabilities: unknown;
  sku_active: boolean;
  primary_supplier_sku_id: string | null;
  catalog_id: string | null;
  selection_status: string | null;
  catalog_enabled: boolean | null;
  domain_status: string | null;
  is_missing: boolean | null;
  availability: string | null;
}

export type SupplierPurchaseReadiness =
  | {
      ok: true;
      externalSku: string;
      costVnd: number;
      region: string | null;
    }
  | { ok: false; reason: "SUPPLIER_UNAVAILABLE" | "SUPPLIER_UNSUPPORTED" };
function storedCapability(capabilities: unknown, capability: string): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability);
}

function catalogManaged(row: SupplierMappingRow, provider: SupplierPurchaseProvider): boolean {
  return (
    storedCapability(row.provider_capabilities, "CATALOG_LIST") ||
    ("capabilities" in provider && hasSupplierCapability(provider, "CATALOG_LIST"))
  );
}

function orderCreationSupported(
  row: SupplierMappingRow,
  provider: SupplierPurchaseProvider,
): boolean {
  if ("capabilities" in provider) return hasSupplierCapability(provider, "ORDER_CREATE");
  if (Array.isArray(row.provider_capabilities) && row.provider_capabilities.length > 0) {
    return storedCapability(row.provider_capabilities, "ORDER_CREATE");
  }
  return true;
}

function unavailable(
  reason: "SUPPLIER_UNAVAILABLE" | "SUPPLIER_UNSUPPORTED",
): SupplierPurchaseReadiness {
  return { ok: false, reason };
}

function evaluateMapping(
  row: SupplierMappingRow,
  provider: SupplierPurchaseProvider,
  purchaseEnabled: boolean,
): SupplierPurchaseReadiness {
  if (purchaseEnabled !== true || !orderCreationSupported(row, provider)) {
    return unavailable("SUPPLIER_UNSUPPORTED");
  }
  if (
    row.supplier_status !== "ACTIVE" ||
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

export async function checkSupplierPurchaseReadiness(
  exec: Executor,
  input: {
    variantId: string;
    supplierId: string;
    supplierSkuId: string;
    provider: SupplierPurchaseProvider;
    purchaseEnabled: boolean;
  },
): Promise<SupplierPurchaseReadiness> {
  const result = await sql<SupplierMappingRow>`
    select
      s.id as supplier_id,
      ss.id as supplier_sku_id,
      ss.external_sku,
      ss.cost_vnd,
      ss.region,
      s.status as supplier_status,
      s.provider_capabilities,
      ss.is_active as sku_active,
      v.supplier_sku_id as primary_supplier_sku_id,
      cp.id as catalog_id,
      cp.selection_status,
      cp.is_enabled as catalog_enabled,
      cp.domain_status,
      cp.is_missing,
      cp.availability
    from supplier_sku ss
    join supplier s on s.id = ss.supplier_id
    join product_variant v on v.id = ss.variant_id
    left join supplier_catalog_product cp
      on cp.supplier_id = s.id and cp.supplier_sku_id = ss.id
    where ss.id = ${input.supplierSkuId}
      and ss.supplier_id = ${input.supplierId}
      and ss.variant_id = ${input.variantId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row
    ? evaluateMapping(row, input.provider, input.purchaseEnabled)
    : unavailable("SUPPLIER_UNAVAILABLE");
}
