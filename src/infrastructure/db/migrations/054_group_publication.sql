-- Group publication: restock generations and social-proof ledger.
--
-- Restock publication is generation-based: a variant gets ONE "back in stock" post per
-- 0 -> >0 sellable transition. `generation` is the dedupe key (paired with the outbox
-- unique index so a restart or double scan cannot republish).
alter table group_restock_generation
  add column if not exists generation integer not null default 0,
  add column if not exists last_seen_sellable integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

-- Social proof is exactly-once per order; the ledger records every order the detector has
-- evaluated so an ineligible one is not rescanned forever, together with why it was skipped.
create table if not exists group_social_proof_publication (
  order_id text primary key,
  outcome text not null check (outcome in ('QUEUED', 'SKIPPED')),
  reason text,
  evaluated_at timestamptz not null default now()
);

create index if not exists group_social_proof_evaluated_idx
  on group_social_proof_publication (evaluated_at);
