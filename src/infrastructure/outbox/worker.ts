import type { Db } from "../db/transaction.js";
import { sql } from "kysely";
import { isKnownOutboxEventType, type DispatchDecision } from "./dispatch-policy.js";
import {
  claimDueOutboxBatch,
  markOutboxPublished,
  recordOutboxFailure,
  type OutboxEvent,
} from "./repository.js";

/**
 * Outbox drainer (side-effect dispatcher) — T134 / T135.
 *
 * `drainOutboxOnce` performs a single poll cycle:
 *   1. durable-claim a batch (owner + lease) via atomic UPDATE … RETURNING;
 *   2. reject unknown event types visibly (never ack as published);
 *   3. run each known event through the handler;
 *   4. apply the dispatch decision: PUBLISHED / RETRY / TERMINAL_REVIEW.
 *
 * It is deliberately one-shot so the worker loop (src/worker.ts) controls
 * cadence and tests can drive it deterministically. Concurrent pollers never
 * double-own a row because the claim is a durable lease, not an autocommit
 * row lock.
 *
 * Delivery is at-least-once; downstream consumers dedupe on domain unique keys
 * for exactly-once effects.
 */

export type OutboxHandler = (event: OutboxEvent) => Promise<DispatchDecision>;

export interface DrainOptions {
  batchSize: number;
  maxAttempts: number;
  handler: OutboxHandler;
  /** Opaque worker identity for the durable lease. Generated if omitted. */
  ownerId?: string;
  /** Lease duration in seconds. */
  leaseSeconds?: number;
}

export interface DrainResult {
  claimed: number;
  published: number;
  failed: number;
  terminal: number;
  unknown: number;
  stale: number;
}

function unknownEventErrorCode(eventType: string): string {
  return `UNKNOWN_EVENT:${eventType}`.slice(0, 128);
}

export async function drainOutboxOnce(db: Db, options: DrainOptions): Promise<DrainResult> {
  const { batchSize, maxAttempts, handler } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("outbox batchSize must be an integer between 1 and 100");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10_000) {
    throw new RangeError("outbox maxAttempts must be an integer between 1 and 10000");
  }

  const cutoff = await sql<{ cutoff: Date }>`select now() as cutoff`.execute(db);
  const claimOpts: {
    batchSize: number;
    ownerId?: string;
    leaseSeconds?: number;
    occurredBefore: Date;
  } = {
    // Bound active ownership to one event. A slow handler can therefore only
    // let one lease expire, and generation fencing rejects its stale ack/fail.
    batchSize: 1,
    occurredBefore: cutoff.rows[0]!.cutoff,
  };
  if (options.ownerId !== undefined) claimOpts.ownerId = options.ownerId;
  if (options.leaseSeconds !== undefined) claimOpts.leaseSeconds = options.leaseSeconds;

  let claimed = 0;
  let published = 0;
  let failed = 0;
  let terminal = 0;
  let unknown = 0;
  let stale = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const event = (await claimDueOutboxBatch(db, claimOpts))[0];
    if (!event) break;
    claimed += 1;
    // Unknown event types fail visibly so a newer producer cannot be silently
    // dropped by an older worker (T135 finding).
    if (!isKnownOutboxEventType(event.eventType)) {
      const applied = await recordOutboxFailure(
        db,
        event,
        unknownEventErrorCode(event.eventType),
        maxAttempts,
      );
      unknown += 1;
      if (applied) failed += 1;
      else stale += 1;
      continue;
    }

    try {
      const decision = await handler(event);
      switch (decision.kind) {
        case "PUBLISHED":
          if (await markOutboxPublished(db, event)) published += 1;
          else stale += 1;
          break;
        case "RETRY":
          if (await recordOutboxFailure(db, event, decision.errorCode, maxAttempts)) failed += 1;
          else stale += 1;
          break;
        case "TERMINAL_REVIEW":
          // Force dead-letter by recording failure with maxAttempts=1 equivalent:
          // bump to the budget so the row parks without infinite spin.
          if (await recordOutboxFailure(db, event, decision.errorCode, 1)) {
            terminal += 1;
            failed += 1;
          } else stale += 1;
          break;
        case "UNKNOWN_EVENT": {
          const unknownApplied = await recordOutboxFailure(
            db,
            event,
            unknownEventErrorCode(decision.eventType),
            maxAttempts,
          );
          unknown += 1;
          if (unknownApplied) failed += 1;
          else stale += 1;
          break;
        }
        default: {
          // Exhaustiveness: a future decision kind must not be silently acked.
          const _never: never = decision;
          void _never;
          if (await recordOutboxFailure(db, event, "UNKNOWN_DECISION", maxAttempts)) failed += 1;
          else stale += 1;
        }
      }
    } catch (err) {
      // Handler threw — treat as retryable so a transient infra error does not
      // permanently lose a paid Order.
      const code = err instanceof Error ? err.name || err.message.slice(0, 64) : "UNKNOWN_ERROR";
      if (await recordOutboxFailure(db, event, code, maxAttempts)) failed += 1;
      else stale += 1;
    }
  }

  return { claimed, published, failed, terminal, unknown, stale };
}
