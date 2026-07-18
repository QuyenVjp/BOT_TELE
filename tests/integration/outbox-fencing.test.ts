import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { withTransaction } from "../../src/infrastructure/db/transaction.js";
import {
  claimDueOutboxBatch,
  enqueueOutboxEvent,
  markOutboxPublished,
  recordOutboxFailure,
  type OutboxEvent,
} from "../../src/infrastructure/outbox/repository.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

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

async function seed() {
  const id = newId();
  await withTransaction(ctx.db, (trx) =>
    enqueueOutboxEvent(trx, {
      id,
      aggregateType: "PaymentIntent",
      aggregateId: newId(),
      aggregateVersion: 1,
      eventType: "PaymentSettled",
      payloadRedacted: {},
    }),
  );
  return id;
}

describe("outbox owner + generation fencing (T161/T162)", () => {
  it("rejects stale-owner ack and failure after a reclaimer increments generation", async () => {
    const id = await seed();
    const first = (
      await claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "worker-A", leaseSeconds: 1 })
    )[0]!;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reclaimed = (
      await claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "worker-B", leaseSeconds: 60 })
    )[0]!;

    expect(first.generation).toBe(1);
    expect(reclaimed.generation).toBe(2);
    expect(await markOutboxPublished(ctx.db, first)).toBe(false);
    expect(await recordOutboxFailure(ctx.db, first, "STALE_FAILURE", 5)).toBe(false);

    const row = await sql<{
      claimed_by: string | null;
      claim_generation: string;
      attempt_count: number;
      published_at: Date | null;
    }>`
      select claimed_by, claim_generation::text, attempt_count, published_at
      from outbox_event where id = ${id}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      claimed_by: "worker-B",
      claim_generation: "2",
      attempt_count: 0,
      published_at: null,
    });

    expect(await markOutboxPublished(ctx.db, reclaimed)).toBe(true);
  });

  it("lets the current generation fail exactly once and rejects its replay", async () => {
    await seed();
    const claim = (
      await claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "worker-A", leaseSeconds: 60 })
    )[0]!;
    expect(await recordOutboxFailure(ctx.db, claim, "DOWNSTREAM", 5)).toBe(true);
    expect(await recordOutboxFailure(ctx.db, claim, "DOWNSTREAM", 5)).toBe(false);
    const attempts = await sql<{ attempt_count: number }>`
      select attempt_count from outbox_event where id = ${claim.id}
    `.execute(ctx.db);
    expect(attempts.rows[0]?.attempt_count).toBe(1);
  });

  it("rejects unbounded claim and failure inputs before mutating the row", async () => {
    await expect(claimDueOutboxBatch(ctx.db, { batchSize: 0 })).rejects.toThrow(/batch/i);
    await expect(claimDueOutboxBatch(ctx.db, { batchSize: 101 })).rejects.toThrow(/batch/i);
    await expect(claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "   " })).rejects.toThrow(
      /owner/i,
    );
    await expect(
      claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "x".repeat(129) }),
    ).rejects.toThrow(/owner/i);
    await expect(claimDueOutboxBatch(ctx.db, { batchSize: 1, leaseSeconds: 0 })).rejects.toThrow(
      /lease/i,
    );
    await expect(claimDueOutboxBatch(ctx.db, { batchSize: 1, leaseSeconds: 301 })).rejects.toThrow(
      /lease/i,
    );

    await seed();
    const claim = (
      await claimDueOutboxBatch(ctx.db, { batchSize: 1, ownerId: "worker-A", leaseSeconds: 60 })
    )[0]!;
    await expect(recordOutboxFailure(ctx.db, claim, "", 5)).rejects.toThrow(/error code/i);
    await expect(recordOutboxFailure(ctx.db, claim, "x".repeat(129), 5)).rejects.toThrow(
      /error code/i,
    );
    await expect(recordOutboxFailure(ctx.db, claim, "DOWNSTREAM", 0)).rejects.toThrow(/attempt/i);
    await expect(recordOutboxFailure(ctx.db, claim, "DOWNSTREAM", 10_001)).rejects.toThrow(
      /attempt/i,
    );

    const row = await sql<{ attempt_count: number; claimed_by: string | null }>`
      select attempt_count, claimed_by from outbox_event where id = ${claim.id}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ attempt_count: 0, claimed_by: "worker-A" });
  });

  it("reports a fenced acknowledgement as stale instead of published", async () => {
    await seed();
    let reclaimed: OutboxEvent | undefined;

    const result = await drainOutboxOnce(ctx.db, {
      batchSize: 1,
      maxAttempts: 5,
      ownerId: "worker-A",
      leaseSeconds: 1,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        reclaimed = (
          await claimDueOutboxBatch(ctx.db, {
            batchSize: 1,
            ownerId: "worker-B",
            leaseSeconds: 60,
          })
        )[0];
        return { kind: "PUBLISHED" };
      },
    });

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 0, stale: 1 });
    expect(reclaimed).toBeDefined();
    expect(await markOutboxPublished(ctx.db, reclaimed!)).toBe(true);
  });
});
