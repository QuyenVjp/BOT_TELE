-- Forward-only repair for legacy supplier UNKNOWN recovery rows.
-- Older code stored the provider lookup key in external_order_id before query_key
-- existed. Preserve external_order_id for rollback compatibility while teaching
-- current code the durable query key.
update supplier_order
set query_key = external_order_id
where status = 'UNKNOWN'
  and query_key is null
  and external_order_id is not null;

-- A supplier lookup key must identify at most one order; NULL remains unset.
create unique index supplier_order_query_key_uq
  on supplier_order (supplier_id, query_key)
  where query_key is not null;
