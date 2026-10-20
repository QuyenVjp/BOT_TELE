import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { FulfillmentType } from "../catalog/fulfillment-type.js";

/**
 * Availability is numeric only for fulfillment routes backed by finite local stock.
 * Service and supplier routes deliberately remain untracked (`null`), even when
 * legacy rows happen to contain digital assets or supplier mappings.
 */
const FINITE_LOCAL_AVAILABLE_SQL = sql<number | null>`
  case
    when v.fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE') then
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'AVAILABLE'), 0)::int
    when v.fulfillment_type = 'QUANTITY_STOCK' then
      coalesce((select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id), 0)::int
    when v.fulfillment_type = 'DIGITAL_FILE' then
      coalesce((select count(*) from variant_file_artifact a where a.variant_id = v.id and a.is_active), 0)::int
    else null
  end
`;

export interface AdminInventoryListRow {
  id: string;
  name: string;
  variant_count: number;
  in_stock: number;
  low_stock: number;
  out_stock: number;
  active: boolean;
  total_products: number;
  total_variants: number;
  total_in_stock: number;
  total_low_stock: number;
  total_out_stock: number;
}

export interface AdminInventoryListTotals {
  products: number;
  variants: number;
  in_stock: number;
  low_stock: number;
  out_stock: number;
}

export interface AdminInventoryList {
  rows: AdminInventoryListRow[];
  totals: AdminInventoryListTotals;
  held: number;
  waiting: number;
}

export interface AdminInventoryVariantRow {
  id: string;
  name: string;
  sku: string;
  fulfillment_type: FulfillmentType;
  available: number | null;
  reserved: number;
  delivered: number;
  error: number;
  low_stock_threshold: number | null;
  stock_version: number | null;
  active: boolean;
}

export interface AdminInventoryVariantDetail extends AdminInventoryVariantRow {
  product_id: string;
  inventory_fields: unknown;
}

export interface AdminInventoryProduct {
  id: string;
  name: string;
  variants: AdminInventoryVariantRow[];
}

export async function listAdminInventory(exec: Executor): Promise<AdminInventoryList> {
  const result = await sql<AdminInventoryListRow>`
    with variant_stock as (
      select v.id, v.product_id, v.low_stock_threshold, v.is_active as active,
        ${FINITE_LOCAL_AVAILABLE_SQL} as available
      from product_variant v
    ), product_stock as (
      select p.id, p.name_vi as name, p.is_active as active, p.sort_order, count(vs.id) filter (where vs.available is not null)::int as variant_count,
        count(vs.id) filter (where vs.available > 0)::int as in_stock,
        count(vs.id) filter (where vs.low_stock_threshold is not null and vs.low_stock_threshold > 0 and vs.available > 0 and vs.available <= vs.low_stock_threshold)::int as low_stock,
        count(vs.id) filter (where vs.available <= 0)::int as out_stock
      from product p
      left join variant_stock vs on vs.product_id = p.id
      where p.is_archived = false
      group by p.id, p.name_vi, p.is_active, p.sort_order
    )
    select id, name, active, variant_count, in_stock, low_stock, out_stock,
      count(*) over()::int as total_products,
      coalesce(sum(variant_count) over(), 0)::int as total_variants,
      coalesce(sum(in_stock) over(), 0)::int as total_in_stock,
      coalesce(sum(low_stock) over(), 0)::int as total_low_stock,
      coalesce(sum(out_stock) over(), 0)::int as total_out_stock
    from product_stock
    order by sort_order asc, id asc
    limit 20
  `.execute(exec);
  const extraCounts = await sql<{ held: number; waiting: number }>`
    select
      coalesce((select count(*)::int from digital_asset da join product_variant pv on pv.id = da.variant_id join product p on p.id = pv.product_id where da.status = 'RESERVED' and p.is_archived = false), 0)::int as held,
      coalesce((select count(*)::int from preorder_reservation pr where pr.status in ('WAITING_DEPOSIT', 'DEPOSIT_PAID')), 0)::int as waiting
  `.execute(exec);
  const totals = result.rows[0];
  return {
    rows: result.rows,
    totals: {
      products: totals?.total_products ?? 0,
      variants: totals?.total_variants ?? 0,
      in_stock: totals?.total_in_stock ?? 0,
      low_stock: totals?.total_low_stock ?? 0,
      out_stock: totals?.total_out_stock ?? 0,
    },
    held: extraCounts.rows[0]?.held ?? 0,
    waiting: extraCounts.rows[0]?.waiting ?? 0,
  };
}

export async function getAdminInventoryProduct(
  exec: Executor,
  productId: string,
): Promise<AdminInventoryProduct | null> {
  const product = await sql<{ id: string; name: string }>`
    select id, name_vi as name from product where id = ${productId} limit 1
  `.execute(exec);
  const row = product.rows[0];
  if (!row) return null;
  const variants = await sql<AdminInventoryVariantRow>`
    select v.id, v.name_vi as name, v.sku, v.fulfillment_type, v.is_active as active,
      ${FINITE_LOCAL_AVAILABLE_SQL} as available,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('RESERVED','READY')), 0)::int as reserved,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'DELIVERED'), 0)::int as delivered,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('FAILED','SUPPLIER_NEEDS_REVIEW','COMPROMISED','REVOKED')), 0)::int as error,
      v.low_stock_threshold,
      case when v.fulfillment_type = 'QUANTITY_STOCK' then q.version::int else null end as stock_version
    from product_variant v
    left join variant_quantity_stock q on q.variant_id = v.id
    where v.product_id = ${productId}
    order by v.sort_order asc, v.id asc
    limit 20
  `.execute(exec);
  return { id: row.id, name: row.name, variants: variants.rows };
}

export async function getAdminInventoryVariant(
  exec: Executor,
  variantId: string,
): Promise<AdminInventoryVariantDetail | null> {
  const result = await sql<AdminInventoryVariantDetail>`
    select v.product_id, v.id, v.name_vi as name, v.sku, v.fulfillment_type, v.inventory_fields, v.is_active as active,
      ${FINITE_LOCAL_AVAILABLE_SQL} as available,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('RESERVED','READY')), 0)::int as reserved,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status = 'DELIVERED'), 0)::int as delivered,
      coalesce((select count(*) from digital_asset da where da.variant_id = v.id and da.status in ('FAILED','SUPPLIER_NEEDS_REVIEW','COMPROMISED','REVOKED')), 0)::int as error,
      case when v.fulfillment_type = 'QUANTITY_STOCK' then q.version::int else null end as stock_version,
      v.low_stock_threshold
    from product_variant v
    left join variant_quantity_stock q on q.variant_id = v.id
    where v.id = ${variantId}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}
