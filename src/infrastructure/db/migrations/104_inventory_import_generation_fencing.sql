-- Fence every inventory-import session and Sheets challenge with an opaque generation.
-- Refs are scoped by this generation so identical material in a replacement session
-- cannot reuse an older staged Vault handle.
alter table admin_inventory_import
  add column if not exists generation text;

alter table admin_inventory_import
  alter column generation set default md5(random()::text || clock_timestamp()::text);

update admin_inventory_import
set generation = md5(random()::text || clock_timestamp()::text || admin_telegram_user_id || ctid::text)
where generation is null or btrim(generation) = '';

alter table admin_inventory_import
  alter column generation set not null;

alter table admin_inventory_import
  drop constraint if exists admin_inventory_import_generation_check;

alter table admin_inventory_import
  add constraint admin_inventory_import_generation_check check (btrim(generation) <> '');

alter table google_sheets_inventory_intake_challenge
  add column if not exists generation text;

alter table google_sheets_inventory_intake_challenge
  alter column generation set default md5(random()::text || clock_timestamp()::text);

-- Existing live challenges retain the session generation only when the admin/ref
-- pair identifies exactly one live challenge. Ambiguous duplicates get isolated
-- tokens below so no legacy challenge can impersonate the current session.
with unique_live_challenge as (
  select admin_telegram_user_id, input_vault_ref
  from google_sheets_inventory_intake_challenge
  where status in ('PREVIEWED', 'PROCESSING')
  group by admin_telegram_user_id, input_vault_ref
  having count(*) = 1
)
update google_sheets_inventory_intake_challenge c
set generation = s.generation
from admin_inventory_import s
join unique_live_challenge u
  on u.admin_telegram_user_id = s.admin_telegram_user_id
 and u.input_vault_ref is not distinct from s.input_vault_ref
where c.generation is null
  and c.admin_telegram_user_id = u.admin_telegram_user_id
  and c.input_vault_ref is not distinct from u.input_vault_ref
  and c.admin_telegram_user_id = s.admin_telegram_user_id
  and c.input_vault_ref is not distinct from s.input_vault_ref;

update google_sheets_inventory_intake_challenge
set generation = md5(random()::text || clock_timestamp()::text || id || ctid::text)
where generation is null or btrim(generation) = '';

alter table google_sheets_inventory_intake_challenge
  alter column generation set not null;

alter table google_sheets_inventory_intake_challenge
  drop constraint if exists google_sheets_inventory_intake_challenge_generation_check;

alter table google_sheets_inventory_intake_challenge
  add constraint google_sheets_inventory_intake_challenge_generation_check check (btrim(generation) <> '');
