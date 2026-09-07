create table if not exists admin_file_artifact_import (
  id text not null,
  admin_telegram_user_id text primary key,
  variant_id text not null references product_variant(id),
  status text not null check (status in ('WAITING_DOCUMENT','READY','COMMITTED','CANCELLED')),
  generation integer not null default 1 check (generation > 0),
  artifact_id text references variant_file_artifact(id),
  artifact_version integer,
  artifact_sha256 text,
  filename text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check ((status in ('READY','COMMITTED')) = (artifact_id is not null and artifact_version is not null and artifact_sha256 is not null and filename is not null))
);
create index if not exists admin_file_artifact_import_expiry_idx on admin_file_artifact_import(expires_at);

alter table admin_callback_state
  drop constraint if exists admin_callback_state_kind_check;

alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in ('CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE','MANUAL_TASK_COMPLETE','FILE_ARTIFACT_IMPORT_CONFIRM'));
