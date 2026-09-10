import { sql } from "kysely";
import type { Executor } from "../db/transaction.js";
import { newId } from "../../shared/ids/index.js";

/**
 * Transactional outbox repository (SR-006, T133).
 *
 * The outbox is the authoritative delivery mechanism: a domain change and its
 * event row are written in ONE transaction (`enqueueOutboxEvent` takes an
 * `Executor`, so callers pass the in-flight `Trx`). The worker later claims due
 * rows with a DURABLE lease (owner + expiry), dispatches side effects, and acks —
 * giving at-least-once delivery, while unique domain keys downstream keep
 * business effects exactly-once.
 *
 * Claim is an atomic `UPDATE … RETURNING` that stamps `claimed_by` /
 * `claim_expires_at`. A `FOR UPDATE SKIP LOCKED` subquery selects candidates
 * inside the same statement so concurrent claimers never double-own a row. An
 * expired lease is reclaimable by any worker (crash recovery).
 *
 * Rows are never deleted on success; `published_at` marks completion so replay
 * and audit stay observable.
 */

/** Default lease duration for a claimed batch (seconds). */
export const DEFAULT_CLAIM_LEASE_SECONDS = 60;

/** Raw persisted shape (snake_case, mirrors the migration). */
export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  payload_redacted: Record<string, unknown>;
  occurred_at: Date;
  published_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error_code: string | null;
  dead_lettered_at: Date | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  claim_generation: string | number;
}

/** Input for emitting an event; ids are caller-supplied opaque ULIDs. */
export interface EnqueueOutboxInput {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payloadRedacted: Record<string, unknown>;
}

/** A due event handed to the worker's dispatcher. */
export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payloadRedacted: Record<string, unknown>;
  attemptCount: number;
  claimedBy: string;
  generation: number;
}

function toEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    payloadRedacted: row.payload_redacted,
    attemptCount: row.attempt_count,
    claimedBy: row.claimed_by!,
    generation: Number(row.claim_generation),
  };
}

/**
 * Insert an event. MUST run inside the same transaction as the aggregate
 * mutation. The dedupe unique index rejects a second emission of the same
 * (aggregate_type, aggregate_id, aggregate_version, event_type).
 */
export async function enqueueOutboxEvent(exec: Executor, input: EnqueueOutboxInput): Promise<void> {
  await sql`
    insert into outbox_event
      (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
    values
      (${input.id}, ${input.aggregateType}, ${input.aggregateId}, ${input.aggregateVersion},
       ${input.eventType}, ${JSON.stringify(input.payloadRedacted)}::jsonb)
  `.execute(exec);
}

export interface ClaimOptions {
  batchSize: number;
  /** Opaque worker identity that owns the lease. Generated if omitted. */
  ownerId?: string;
  /** Lease duration in seconds (default {@link DEFAULT_CLAIM_LEASE_SECONDS}). */
  leaseSeconds?: number;
  /** Do not chase events emitted by handlers during the same drain cycle. */
  occurredBefore?: Date | string;
}

/**
 * Atomically claim a batch of due, unpublished, non-dead-lettered events.
 *
 * Uses a single `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`
 * statement so:
 *   1. the row lock is held only for the duration of the claim statement;
 *   2. the durable lease (claimed_by + claim_expires_at) is the authority for
 *      ownership across the subsequent handler dispatch;
 *   3. concurrent claimers never double-own a row;
 *   4. a crashed worker's expired lease is reclaimable by the next poller.
 *
 * The previous implementation ran `FOR UPDATE SKIP LOCKED` on an autocommit
 * pooled connection, so the lock vanished the instant the SELECT returned and
 * two pollers could process the same event (T133 finding).
 */
export async function claimDueOutboxBatch(
  exec: Executor,
  batchSizeOrOptions: number | ClaimOptions,
): Promise<OutboxEvent[]> {
  const options: ClaimOptions =
    typeof batchSizeOrOptions === "number" ? { batchSize: batchSizeOrOptions } : batchSizeOrOptions;
  const batchSize = options.batchSize;
  const ownerId = options.ownerId ?? `worker-${newId().slice(-12)}`;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;
  const occurredBefore =
    options.occurredBefore instanceof Date
      ? options.occurredBefore.toISOString()
      : (options.occurredBefore ?? null);

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("outbox batchSize must be an integer between 1 and 100");
  }
  if (ownerId.trim().length === 0 || ownerId.length > 128) {
    throw new RangeError("outbox ownerId must be non-empty and at most 128 characters");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
    throw new RangeError("outbox leaseSeconds must be an integer between 1 and 300");
  }

  // Atomic claim: stamp lease on up to `batchSize` claimable rows and return them.
  // Claimable = unpublished, not dead-lettered, backoff elapsed, and either
  // unclaimed or with an expired lease.
  const result = await sql<OutboxRow>`
    update outbox_event as o
    set claimed_by = ${ownerId},
        claimed_at = now(),
        claim_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
        claim_generation = claim_generation + 1
    from (
      select id
      from outbox_event
      where published_at is null
        and dead_lettered_at is null
        and (next_attempt_at is null or next_attempt_at <= now())
        and (claim_expires_at is null or claim_expires_at <= now())
        and (${occurredBefore}::timestamptz is null or occurred_at <= ${occurredBefore}::timestamptz)
      order by occurred_at asc, id asc
      limit ${batchSize}
      for update skip locked
    ) as candidates
    where o.id = candidates.id
    returning o.*
  `.execute(exec);

  return result.rows.map(toEvent);
}

/** Ack an event as durably published (exactly-once completion marker). */
export async function markOutboxPublished(
  exec: Executor,
  claim: Pick<OutboxEvent, "id" | "claimedBy" | "generation">,
): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update outbox_event
    set published_at = now(),
        next_attempt_at = null,
        claimed_by = null,
        claimed_at = null,
        claim_expires_at = null,
        last_error_code = null
    where id = ${claim.id}
      and published_at is null
      and claimed_by = ${claim.claimedBy}
      and claim_generation = ${claim.generation}
    returning id
  `.execute(exec);
  return result.rows.length === 1;
}

/**
 * Record a delivery failure. Increments the attempt count, sets an exponential
 * backoff `next_attempt_at`, releases the lease so another worker can pick it
 * up after the backoff, and — once the bounded attempt budget is exhausted —
 * dead-letters the row so the poller stops re-delivering a poison event.
 *
 * `RATE_LIMITED` is backpressure rather than a poison event: it neither consumes the attempt
 * budget nor dead-letters, so a burst of publication work defers and later drains instead of
 * being silently dropped. The row still backs off, so the poller never busy-loops.
 */
export async function recordOutboxFailure(
  exec: Executor,
  claim: Pick<OutboxEvent, "id" | "claimedBy" | "generation">,
  errorCode: string,
  maxAttempts: number,
): Promise<boolean> {
  if (errorCode.trim().length === 0 || errorCode.length > 128) {
    throw new RangeError("outbox error code must be non-empty and at most 128 characters");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10_000) {
    throw new RangeError("outbox maxAttempts must be an integer between 1 and 10000");
  }
  const countsTowardBudget = errorCode !== "RATE_LIMITED";

  // Backoff: 2^attempt seconds, capped at 1 hour. Dead-letter when the next
  // attempt would exceed the budget. Release the lease so the event is free
  // for reclaim after next_attempt_at.
  const result = await sql<{ id: string }>`
    update outbox_event
    set attempt_count = case
          when ${countsTowardBudget} then attempt_count + 1
          else attempt_count
        end,
        last_error_code = ${errorCode},
        next_attempt_at = now() + (least(power(2, attempt_count + 1), 3600) || ' seconds')::interval,
        dead_lettered_at = case
          when ${countsTowardBudget} and attempt_count + 1 >= ${maxAttempts} then now()
          else dead_lettered_at
        end,
        claimed_by = null,
        claimed_at = null,
        claim_expires_at = null
    where id = ${claim.id}
      and published_at is null
      and claimed_by = ${claim.claimedBy}
      and claim_generation = ${claim.generation}
    returning id
  `.execute(exec);
  return result.rows.length === 1;
}

/** Count rows not yet published (includes deferred + dead-lettered). */
export async function countUnpublished(exec: Executor): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from outbox_event where published_at is null
  `.execute(exec);
  return Number(result.rows[0]?.count ?? "0");
}

/** Count rows that exhausted the retry budget (operational visibility). */
export async function countDeadLettered(exec: Executor): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from outbox_event where dead_lettered_at is not null
  `.execute(exec);
  return Number(result.rows[0]?.count ?? "0");
}
