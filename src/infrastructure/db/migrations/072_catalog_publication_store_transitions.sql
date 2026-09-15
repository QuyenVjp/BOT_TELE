-- Protected catalog publication and explicit store-mode transitions.
-- Legacy product_variant.resale_evidence_id remains untouched; public visibility
-- additionally requires the current version-bound publication fields below.

create table if not exists resale_evidence (
  id text primary key,
  variant_id text not null references product_variant (id),
  source text not null check (source in ('SUPPLIER_AUTHORIZATION','OWNER_ATTESTATION','CONTRACT_REFERENCE')),
  reference text not null check (length(reference) between 1 and 200),
  summary text not null check (length(summary) between 1 and 500),
  metadata_redacted jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  created_by text not null,
  registration_request_id text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text
);
create index if not exists resale_evidence_variant_status_idx
  on resale_evidence (variant_id, status);
create unique index if not exists resale_evidence_request_uq
  on resale_evidence (registration_request_id) where registration_request_id is not null;
create unique index if not exists resale_evidence_active_variant_uq
  on resale_evidence (variant_id) where status = 'ACTIVE';

-- Evidence metadata is append-only. Revocation changes only status/provenance.
create or replace function prevent_resale_evidence_mutation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'resale evidence is immutable';
  end if;
  if old.id is distinct from new.id
     or old.variant_id is distinct from new.variant_id
     or old.source is distinct from new.source
     or old.reference is distinct from new.reference
     or old.summary is distinct from new.summary
     or old.metadata_redacted is distinct from new.metadata_redacted
     or old.created_by is distinct from new.created_by
     or old.registration_request_id is distinct from new.registration_request_id
     or old.created_at is distinct from new.created_at then
    raise exception 'resale evidence facts are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists resale_evidence_immutable_guard on resale_evidence;
create trigger resale_evidence_immutable_guard
before update or delete on resale_evidence
for each row execute function prevent_resale_evidence_mutation();

alter table product_variant
  add column if not exists publication_evidence_id text references resale_evidence (id),
  add column if not exists publication_product_version integer,
  add column if not exists publication_variant_version integer,
  add column if not exists published_at timestamptz,
  add column if not exists published_by text;
create index if not exists product_variant_publication_idx
  on product_variant (publication_evidence_id, publication_product_version, publication_variant_version);

alter table store_control drop constraint if exists store_control_status_check;
alter table store_control add constraint store_control_status_check
  check (status in ('OPEN','CLOSED','TEST'));
alter table store_control
  add column if not exists version integer not null default 1,
  add column if not exists last_request_id text;

create table if not exists store_mode_transition (
  id text primary key,
  store_id text not null references store_control (id),
  from_status text not null check (from_status in ('OPEN','CLOSED','TEST')),
  to_status text not null check (to_status in ('OPEN','CLOSED','TEST')),
  expected_version integer not null,
  resulting_version integer not null,
  request_id text not null unique,
  actor_id text not null,
  reason text not null check (length(reason) between 1 and 500),
  correlation_id text not null,
  created_at timestamptz not null default now(),
  check (from_status <> to_status)
);
create index if not exists store_mode_transition_store_idx
  on store_mode_transition (store_id, created_at desc);
