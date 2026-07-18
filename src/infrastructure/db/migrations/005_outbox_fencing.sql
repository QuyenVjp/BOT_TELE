-- T161/T162: generation-fenced outbox ownership.
-- Every claim increments this monotonic token. Ack/fail statements predicate on
-- both owner and generation so a worker whose lease expired cannot mutate a
-- row reclaimed by a newer worker.

alter table outbox_event
  add column if not exists claim_generation bigint not null default 0;

