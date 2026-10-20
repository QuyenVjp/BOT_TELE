-- 097_supplier_catalog_owner_intent.sql
-- Decouple owner intent from upstream domain availability and restore only
-- catalog rows whose latest explicit owner decision was enabled=true.

-- 093 created this unnamed CHECK as the final constraint on the table. Find it
-- by its expression rather than by PostgreSQL's generated constraint name, and
-- drop no other CHECK constraint.
do $$
declare
  legacy_constraint text;
begin
  select c.conname
    into legacy_constraint
  from pg_constraint c
  where c.conrelid = 'supplier_catalog_product'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ~* 'domain_status[[:space:]]*=[[:space:]]*''SUPPORTED'''
    and pg_get_constraintdef(c.oid) ~* 'not[[:space:]]+is_enabled'
  limit 1;

  if legacy_constraint is not null then
    execute format(
      'alter table supplier_catalog_product drop constraint %I',
      legacy_constraint
    );
  end if;
end;
$$;

with latest_owner_action as (
  select distinct on (ae.target_id)
    ae.target_id,
    ae.metadata_redacted -> 'enabled' as enabled_value
  from audit_event ae
  where ae.actor_type = 'ROOT_ADMIN'
    and ae.target_type = 'SupplierCatalogProduct'
    and ae.action in (
      'supplier.catalog.configure',
      'supplier.catalog.enable',
      'supplier.catalog.disable'
    )
  order by ae.target_id, ae.occurred_at desc, ae.id desc
)
update supplier_catalog_product cp
set is_enabled = true,
    updated_at = now(),
    version = cp.version + 1
from latest_owner_action loa
where cp.id = loa.target_id
  and loa.enabled_value = 'true'::jsonb
  and not cp.is_enabled;
