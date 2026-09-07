-- Snapshot fulfillment type onto orders so fulfillment routing is immutable after Buy Now.
alter table "order"
  add column if not exists fulfillment_type text;

create or replace function order_snapshot_fulfillment_type(
  delivery_type text,
  supplier_policy_snapshot text
) returns text
language plpgsql
immutable
as $$
begin
  if supplier_policy_snapshot = 'SUPPLIER_ONLY' then
    return 'SUPPLIER_API';
  end if;

  case delivery_type
    when 'CREDENTIAL' then return 'STOCK_ACCOUNT';
    when 'LICENSE' then return 'STOCK_CODE';
    when 'ACTIVATION_KEY' then return 'STOCK_CODE';
    when 'MANUAL_REVIEW' then return 'MANUAL_FULFILLMENT';
    when 'INVITE' then return 'MANUAL_FULFILLMENT';
    else return 'MANUAL_FULFILLMENT';
  end case;
end;
$$;

create or replace function order_set_snapshot_fulfillment_type()
returns trigger
language plpgsql
as $$
begin
  new.fulfillment_type := coalesce(
    new.fulfillment_type,
    order_snapshot_fulfillment_type(new.delivery_type, new.supplier_policy_snapshot)
  );
  return new;
end;
$$;

drop trigger if exists order_set_snapshot_fulfillment_type on "order";
create trigger order_set_snapshot_fulfillment_type
before insert on "order"
for each row execute function order_set_snapshot_fulfillment_type();

update "order"
set fulfillment_type = order_snapshot_fulfillment_type(delivery_type, supplier_policy_snapshot)
where fulfillment_type is null;

do $$
begin
  alter table "order"
    add constraint order_fulfillment_type_check
    check (fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE','DIGITAL_FILE','SUPPLIER_API','MANUAL_FULFILLMENT','QUANTITY_STOCK','UNLIMITED_SERVICE'));
exception
  when duplicate_object then null;
end;
$$;

alter table "order"
  alter column fulfillment_type set not null;
