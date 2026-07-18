import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  enqueueOutboxEvent,
  claimDueOutboxBatch,
} from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T130 — Two-worker / overlapping-poll lease.
 *
 * Each outbox event must have exactly one active claimant. Two pollers running
 * concurrently must partition the batch (no row claimed by both), and a handler
 * that runs under the lease must execute each event exactly once even when two
 * drains race.
 *
 * Requires Docker/Testcontainers; skipped with an explicit reason otherwise.
 */

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("outbox concurrency lease (T130)", () => {
  let ctx: PgTestContext;

  beforeAll(async () => {
    ctx = await startPostgresContainer();
  }, 180_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await sql`truncate table outbox_event`.execute(ctx.db);
  });

  function known(id: string) {
    return {
      id,
      aggregateType: "PaymentIntent",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "PaymentSettled",
      payloadRedacted: {},
    };
  }

  it("two concurrent claims partition the batch (no row owned twice)", async () => {
    const ids = Array.from({ length: 20 }, () => newId());
    await withTransaction(ctx.db, async (trx) => {
      for (const id of ids) await enqueueOutboxEvent(trx, known(id));
    });

    const [a, b] = await Promise.all([
      claimDueOutboxBatch(ctx.db, { batchSize: 20, ownerId: "A", leaseSeconds: 60 }),
      claimDueOutboxBatch(ctx.db, { batchSize: 20, ownerId: "B", leaseSeconds: 60 }),
    ]);

    const aIds = new Set(a.map((e) => e.id));
    const bIds = new Set(b.map((e) => e.id));
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
    // Together they cover at most the 20 rows, each at most once.
    expect(a.length + b.length).toBeLessThanOrEqual(20);
    expect(new Set([...aIds, ...bIds]).size).toBe(a.length + b.length);
  });

  it("two concurrent drains dispatch each event exactly once", async () => {
    const ids = Array.from({ length: 15 }, () => newId());
    await withTransaction(ctx.db, async (trx) => {
      for (const id of ids) await enqueueOutboxEvent(trx, known(id));
    });

    const dispatched: string[] = [];
    const handler = async (event: { id: string }) => {
      dispatched.push(event.id);
      return { kind: "PUBLISHED" as const };
    };

    await Promise.all([
      drainOutboxOnce(ctx.db, { batchSize: 15, maxAttempts: 5, handler, ownerId: "A" }),
      drainOutboxOnce(ctx.db, { batchSize: 15, maxAttempts: 5, handler, ownerId: "B" }),
    ]);

    // Exactly-once dispatch: no event handled twice.
    const unique = new Set(dispatched);
    expect(unique.size).toBe(dispatched.length);
    expect(dispatched.length).toBe(15);

    const unpublished = await sql<{ count: string }>`
      select count(*)::text as count from outbox_event where published_at is null
    `.execute(ctx.db);
    expect(Number(unpublished.rows[0]?.count)).toBe(0);
  });
});
