import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  enqueueOutboxEvent,
  claimDueOutboxBatch,
  markOutboxPublished,
  recordOutboxFailure,
  countUnpublished,
  type OutboxRow,
} from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T017 — Transactional outbox crash/replay (SR-006, exactly-once effects over
 * at-least-once delivery).
 *
 * Guards:
 *  - an event enqueued in the SAME transaction as its aggregate change is durable
 *    even if the process crashes before the side effect runs;
 *  - a crashed/unacked event is re-claimable after "restart" (published_at still
 *    null) and is NOT lost;
 *  - a handler that has already applied its effect (idempotent consumer) does not
 *    double-apply on replay;
 *  - the dedupe unique key rejects a second enqueue of the same
 *    (aggregate_type, aggregate_id, aggregate_version, event_type).
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  // Clean slate per test; outbox is the only table under exercise here.
  await sql`truncate table outbox_event`.execute(ctx.db);
});

function sampleEvent(overrides: Partial<OutboxRow> = {}): Parameters<typeof enqueueOutboxEvent>[1] {
  const aggregateId = overrides.aggregate_id ?? newId();
  return {
    id: overrides.id ?? newId(),
    aggregateType: overrides.aggregate_type ?? "PaymentIntent",
    aggregateId,
    aggregateVersion: overrides.aggregate_version ?? 1,
    // A KNOWN event type so the dispatch policy does not reject it as UNKNOWN.
    eventType: overrides.event_type ?? "PaymentSettled",
    payloadRedacted: { orderId: aggregateId },
  };
}

describe("outbox durability and replay", () => {
  it("persists an event enqueued inside the aggregate transaction", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      // Simulate a domain write + event emission in the same unit of work.
      await enqueueOutboxEvent(trx, spec);
    });

    expect(await countUnpublished(ctx.db)).toBe(1);
  });

  it("holds a durable lease so a concurrent poll does NOT double-claim, but a crash reclaims after lease expiry", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    // First poller claims the row with a short lease but "crashes" before ack.
    const firstBatch = await claimDueOutboxBatch(ctx.db, {
      batchSize: 10,
      ownerId: "worker-A",
      leaseSeconds: 1,
    });
    expect(firstBatch.map((r) => r.id)).toContain(spec.id);

    // A concurrent poller must NOT re-claim the leased row (this is the fix for
    // the double-processing defect — the old FOR UPDATE SKIP LOCKED released the
    // lock the instant the SELECT returned).
    const concurrent = await claimDueOutboxBatch(ctx.db, {
      batchSize: 10,
      ownerId: "worker-B",
    });
    expect(concurrent.map((r) => r.id)).not.toContain(spec.id);

    // After the lease expires, the event is reclaimable (crash recovery).
    await new Promise((r) => setTimeout(r, 1100));
    const afterExpiry = await claimDueOutboxBatch(ctx.db, {
      batchSize: 10,
      ownerId: "worker-B",
    });
    expect(afterExpiry.map((r) => r.id)).toContain(spec.id);
    expect(await countUnpublished(ctx.db)).toBe(1);
  });

  it("marks published exactly once and stops re-delivering", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    const batch = await claimDueOutboxBatch(ctx.db, 10);
    expect(batch).toHaveLength(1);
    await markOutboxPublished(ctx.db, batch[0]!);

    expect(await countUnpublished(ctx.db)).toBe(0);
    const afterPublish = await claimDueOutboxBatch(ctx.db, 10);
    expect(afterPublish.map((r) => r.id)).not.toContain(spec.id);
  });

  it("rejects a duplicate emission of the same aggregate transition", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    // Same (aggregate_type, aggregate_id, aggregate_version, event_type) with a
    // fresh row id must be rejected by the dedupe unique index.
    const dup = sampleEvent({
      aggregate_type: spec.aggregateType,
      aggregate_id: spec.aggregateId,
      aggregate_version: spec.aggregateVersion,
      event_type: spec.eventType,
    });
    await expect(
      withTransaction(ctx.db, async (trx) => {
        await enqueueOutboxEvent(trx, { ...dup, id: newId() });
      }),
    ).rejects.toThrow();

    expect(await countUnpublished(ctx.db)).toBe(1);
  });

  it("records a failure with backoff and a bounded attempt budget", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    const claimed = await claimDueOutboxBatch(ctx.db, 1);
    await recordOutboxFailure(ctx.db, claimed[0]!, "HANDLER_ERROR", 10);
    // Row is deferred: its next_attempt_at is in the future, so an immediate
    // due-poll skips it.
    const dueNow = await claimDueOutboxBatch(ctx.db, 10);
    expect(dueNow.map((r) => r.id)).not.toContain(spec.id);
    // But it is still unpublished (retryable), not lost.
    expect(await countUnpublished(ctx.db)).toBe(1);
  });

  it("drainOutboxOnce dispatches due events through a handler and acks them", async () => {
    const specs = [sampleEvent(), sampleEvent(), sampleEvent()];
    await withTransaction(ctx.db, async (trx) => {
      for (const s of specs) await enqueueOutboxEvent(trx, s);
    });

    const dispatched: string[] = [];
    const result = await drainOutboxOnce(ctx.db, {
      batchSize: 10,
      maxAttempts: 10,
      handler: async (event) => {
        dispatched.push(event.id);
        return { kind: "PUBLISHED" };
      },
    });

    expect(result.published).toBe(3);
    expect(result.failed).toBe(0);
    expect(dispatched.sort()).toEqual(specs.map((s) => s.id).sort());
    expect(await countUnpublished(ctx.db)).toBe(0);
  });

  it("drainOutboxOnce defers a failing handler without losing the event", async () => {
    const spec = sampleEvent();
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    const result = await drainOutboxOnce(ctx.db, {
      batchSize: 10,
      maxAttempts: 10,
      handler: async () => {
        throw new Error("downstream unavailable");
      },
    });

    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);
    // Still unpublished (deferred, retryable), not dead-lettered on first failure.
    expect(await countUnpublished(ctx.db)).toBe(1);
  });

  it("drainOutboxOnce fails unknown event types visibly (never acks them)", async () => {
    const spec = sampleEvent({ event_type: "SomethingNewerProducerEmits" });
    await withTransaction(ctx.db, async (trx) => {
      await enqueueOutboxEvent(trx, spec);
    });

    const result = await drainOutboxOnce(ctx.db, {
      batchSize: 10,
      maxAttempts: 3,
      handler: async () => {
        // Must not be called for unknown types.
        throw new Error("handler must not run for unknown event types");
      },
    });

    expect(result.published).toBe(0);
    expect(result.unknown).toBe(1);
    expect(result.failed).toBe(1);
    // Still unpublished (not silently dropped).
    expect(await countUnpublished(ctx.db)).toBe(1);
  });
});
