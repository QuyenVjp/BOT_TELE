-- Preserve selected-variant import binding across repeated previews.
alter table admin_inventory_import
  add column if not exists selected_variant_id text;

create index if not exists admin_inventory_import_selected_variant_idx
  on admin_inventory_import (selected_variant_id)
  where selected_variant_id is not null;
