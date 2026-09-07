create table if not exists file_delivery_job (
  order_id text primary key references "order"(id),
  customer_id text not null references customer(id),
  variant_id text not null references product_variant(id),
  artifact_id text not null references variant_file_artifact(id),
  artifact_version integer not null check (artifact_version > 0),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  telegram_chat_id text not null,
  status text not null check (status in ('QUEUED','PROCESSING','SENT','FAILED')) default 'QUEUED',
  telegram_file_id text,
  telegram_file_unique_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claim_generation integer not null default 0 check (claim_generation >= 0),
  processing_expires_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, artifact_id, artifact_version, artifact_sha256)
);

create index if not exists file_delivery_job_status_created_idx
  on file_delivery_job(status, created_at);
