import { sql } from "kysely";

/** Supplier readiness predicate. Expects the outer variant alias `v`. */
export const SUPPLIER_READY_SQL = sql`
  exists (
    select 1
    from supplier_sku ss
    join supplier s on s.id = ss.supplier_id
    where ss.variant_id = v.id
      and ss.id = v.supplier_sku_id
      and ss.is_active
      and s.status = 'ACTIVE'
      and (
        (
          not (s.provider_capabilities @> '["CATALOG_LIST"]'::jsonb)
          and not exists (
            select 1 from supplier_catalog_product cp where cp.supplier_sku_id = ss.id
          )
        )
        or exists (
          select 1
          from supplier_catalog_product cp
          where cp.supplier_id = s.id
            and cp.supplier_sku_id = ss.id
            and cp.selection_status = 'SELECTED'
            and cp.domain_status = 'SUPPORTED'
            and cp.is_enabled
            and not cp.is_missing
            and cp.availability in ('AVAILABLE', 'LOW')
        )
      )
  )
`;

/** Route readiness uses the same purchase-safe supplier predicate. */
export const SUPPLIER_ROUTE_SQL = SUPPLIER_READY_SQL;
