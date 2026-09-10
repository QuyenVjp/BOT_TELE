import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createPostgresTelegramInbox,
  processTelegramInboxBatch,
  RETAINED_ENVELOPE_KEYS,
  type TelegramCommandEnvelope,
  type TelegramInbox,
} from "../../src/infrastructure/inbox/telegram.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Telegram inbox credential retention + burst drain.
 *
 * Admin inventory imports paste `email|password` lines into a chat message, so the raw
 * update envelope is credential-bearing. These tests pin the two guarantees that keep
 * that out of durable storage: the payload is redacted when the update stops needing to
 * be replayed, and throttled updates reschedule instead of burning the retry budget.
 */

let ctx: PgTestContext;
beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());
beforeEach(async () => {
  await sql`truncate table webhook_inbox cascade`.execute(ctx.db);
});

const FAKE_MARKER = "FINAL-REAL-PASS-004";
const FAKE_LINE = `final.real.001@example.invalid|final.real.001@example.invalid|${FAKE_MARKER}`;

function importEnvelope(): TelegramCommandEnvelope {
  return {
    actorUserId: "6659186592",
    chatId: "6659186592",
    chatType: "private",
    messageId: "700",
    action: "ADMIN",
    messageText: FAKE_LINE,
    inventoryImportText: true,
  };
}

function hash(seed: string): string {
  return seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, "a");
}

async function acceptOne(inbox: TelegramInbox, id: string) {
  return inbox.accept({ sourceEventId: id, rawHash: hash(id), envelope: importEnvelope() });
}

async function claimAndProcess(inbox: TelegramInbox) {
  const [claim] = await inbox.claimDue({ owner: "test-worker", batchSize: 1, leaseSeconds: 30 });
  if (!claim) throw new Error("no claim");
  const processed = await inbox.markProcessed(claim);
  if (!processed) throw new Error("markProcessed lost the claim");
  return claim;
}

function envelopeOf(id: string) {
  return sql<{ envelope: Record<string, unknown> }>`
    select envelope from webhook_inbox where source_event_id = ${id}
  `
    .execute(ctx.db)
    .then((r) => r.rows[0]!.envelope);
}

describe("Telegram inbox credential retention", () => {
  it("redacts the pending payload as soon as the update is processed", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "1001");
    expect(JSON.stringify(await envelopeOf("1001"))).toContain(FAKE_MARKER);

    await claimAndProcess(inbox);

    const stored = await envelopeOf("1001");
    expect(JSON.stringify(stored)).not.toContain(FAKE_MARKER);
    expect(JSON.stringify(stored)).not.toContain(FAKE_LINE);
    expect(stored).not.toHaveProperty("messageText");
    expect(typeof stored.redactedAt).toBe("string");
    // Delivery identity and audit metadata survive.
    expect(stored.actorUserId).toBe("6659186592");
    expect(stored.messageId).toBe("700");
    expect(stored.action).toBe("ADMIN");
    expect(stored.inventoryImportText).toBe(true);
  });

  it("keeps a retryable payload only inside the grace window and redacts aged rows", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "1002");
    await acceptOne(inbox, "1003");
    const [fresh] = await inbox.claimDue({ owner: "w", batchSize: 2, leaseSeconds: 30 });
    await inbox.markFailed(fresh!, {
      errorCode: "HANDLER_FAILED",
      maxAttempts: 10,
      retryAfterSeconds: 5,
    });

    const redactedNow = await inbox.sanitizePayloads({ batchSize: 10, retryGraceSeconds: 3600 });
    expect(redactedNow).toBe(0);
    expect(JSON.stringify(await envelopeOf("1002"))).toContain(FAKE_MARKER);

    await sql`
      update webhook_inbox set received_at = now() - interval '2 hours'
      where source_event_id = '1002'
    `.execute(ctx.db);
    const redactedAged = await inbox.sanitizePayloads({ batchSize: 10, retryGraceSeconds: 3600 });
    expect(redactedAged).toBe(1);
    expect(JSON.stringify(await envelopeOf("1002"))).not.toContain(FAKE_MARKER);

    // Idempotent: a second pass has nothing left to do.
    expect(await inbox.sanitizePayloads({ batchSize: 10, retryGraceSeconds: 3600 })).toBe(0);
  });

  it("redacts dead-lettered payloads and never keeps a credential in the retained set", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "1004");
    const [claim] = await inbox.claimDue({ owner: "w", batchSize: 1, leaseSeconds: 30 });
    const state = await inbox.markFailed(claim!, {
      errorCode: "HANDLER_FAILED",
      maxAttempts: 1,
      retryAfterSeconds: 5,
    });
    expect(state).toBe("DEAD");
    const stored = await envelopeOf("1004");
    expect(JSON.stringify(stored)).not.toContain(FAKE_MARKER);
    expect(typeof stored.redactedAt).toBe("string");
    expect(RETAINED_ENVELOPE_KEYS).not.toContain("messageText");
  });

  it("prunes only terminal/stale rows and leaves another source's evidence alone", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "1005");
    await claimAndProcess(inbox);
    await acceptOne(inbox, "1006");
    const [claim] = await inbox.claimDue({ owner: "w", batchSize: 1, leaseSeconds: 30 });
    await inbox.markFailed(claim!, {
      errorCode: "HANDLER_FAILED",
      maxAttempts: 1,
      retryAfterSeconds: 5,
    });
    await acceptOne(inbox, "1007");

    await sql`
      insert into webhook_inbox
        (id, source, source_event_id, raw_hash, signature_status, processing_status, envelope)
      values
        ('sepay-row', 'sepay', 'sepay-1', ${hash("sepay")}, 'VERIFIED', 'PROCESSED',
         '{"amount":2000}'::jsonb)
    `.execute(ctx.db);

    await sql`
      update webhook_inbox
      set processed_at = now() - interval '31 days'
      where processing_status = 'PROCESSED' and source = 'telegram'
    `.execute(ctx.db);
    await sql`
      update webhook_inbox
      set dead_lettered_at = now() - interval '91 days'
      where processing_status = 'DEAD'
    `.execute(ctx.db);
    await sql`
      update webhook_inbox
      set received_at = now() - interval '8 days'
      where processing_status = 'RETRY'
    `.execute(ctx.db);

    const pruned = await inbox.prune({
      processedRetentionDays: 30,
      deadRetentionDays: 90,
      staleRetryRetentionDays: 7,
      batchSize: 50,
    });
    expect(pruned).toBe(3);

    const remaining = await sql<{ source: string; source_event_id: string }>`
      select source, source_event_id from webhook_inbox order by source_event_id
    `.execute(ctx.db);
    expect(remaining.rows).toEqual([{ source: "sepay", source_event_id: "sepay-1" }]);
  });

  it("preserves a recent retryable row through a prune cycle", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "1008");
    const [claim] = await inbox.claimDue({ owner: "w", batchSize: 1, leaseSeconds: 30 });
    await inbox.markFailed(claim!, {
      errorCode: "HANDLER_FAILED",
      maxAttempts: 10,
      retryAfterSeconds: 5,
    });
    const pruned = await inbox.prune({
      processedRetentionDays: 30,
      deadRetentionDays: 90,
      staleRetryRetentionDays: 7,
      batchSize: 50,
    });
    expect(pruned).toBe(0);
    expect((await inbox.stats()).dead).toBe(0);
    expect(JSON.stringify(await envelopeOf("1008"))).toContain(FAKE_MARKER);
  });
});

describe("Telegram inbox burst control", () => {
  const BURST = 100;

  function refillingLimiter(capacity: number) {
    let tokens = capacity;
    return {
      refill: () => {
        tokens = capacity;
      },
      tryConsume: async () => {
        if (tokens > 0) {
          tokens -= 1;
          return { allowed: true, retryAfterSeconds: 0 };
        }
        return { allowed: false, retryAfterSeconds: 30 };
      },
    };
  }

  it("drains a 100-update burst with zero permanent RATE_LIMITED loss", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    for (let i = 0; i < BURST; i += 1) await acceptOne(inbox, String(2000 + i));

    const limiter = refillingLimiter(12);
    let handled = 0;
    const handler = async () => {
      handled += 1;
    };

    let rounds = 0;
    for (; rounds < 40; rounds += 1) {
      await processTelegramInboxBatch({
        inbox,
        limiter,
        handler,
        owner: `burst-${rounds}`,
        batchSize: 25,
        maxAttempts: 10,
      });
      // Throttled rows are rescheduled into the future, so "due" alone is not a safe
      // drain signal — check for any row still in flight.
      const inFlight = await sql<{ n: string }>`
        select count(*)::text as n from webhook_inbox
        where source = 'telegram' and processing_status in ('RETRY', 'PROCESSING')
      `.execute(ctx.db);
      if (Number(inFlight.rows[0]?.n ?? "0") === 0) break;
      // Simulate the retry delay elapsing, then let the bucket refill for the next round.
      await sql`
        update webhook_inbox set next_attempt_at = now()
        where source = 'telegram' and processing_status = 'RETRY'
      `.execute(ctx.db);
      await sql`
        update webhook_inbox set claim_expires_at = now() - interval '1 second'
        where source = 'telegram' and processing_status = 'PROCESSING'
      `.execute(ctx.db);
      limiter.refill();
    }

    const statuses = await sql<{ processing_status: string; n: string }>`
      select processing_status, count(*)::text as n from webhook_inbox
      where source = 'telegram' group by processing_status
    `.execute(ctx.db);
    expect(statuses.rows).toEqual([{ processing_status: "PROCESSED", n: String(BURST) }]);
    const final = await inbox.stats();
    expect({ dead: final.dead, handled, rounds: rounds < 40 }).toEqual({
      dead: 0,
      handled: BURST,
      rounds: true,
    });
  });

  it("never dead-letters a throttled update, however many times it is throttled", async () => {
    const inbox = createPostgresTelegramInbox(ctx.db);
    await acceptOne(inbox, "3001");
    const blocked = { tryConsume: async () => ({ allowed: false, retryAfterSeconds: 30 }) };

    for (let i = 0; i < 25; i += 1) {
      await processTelegramInboxBatch({
        inbox,
        limiter: blocked,
        handler: async () => {},
        owner: `throttle-${i}`,
        batchSize: 1,
        maxAttempts: 2,
      });
      await sql`
        update webhook_inbox set next_attempt_at = now()
        where source = 'telegram' and processing_status = 'RETRY'
      `.execute(ctx.db);
    }

    const row = await sql<{
      processing_status: string;
      attempt_count: number;
      last_error_code: string;
      next_attempt_at: Date | null;
    }>`
      select processing_status, attempt_count, last_error_code, next_attempt_at
      from webhook_inbox where source_event_id = '3001'
    `.execute(ctx.db);
    expect(row.rows[0]?.processing_status).toBe("RETRY");
    expect(row.rows[0]?.attempt_count).toBe(0);
    expect(row.rows[0]?.last_error_code).toBe("RATE_LIMITED");
    expect(row.rows[0]?.next_attempt_at).not.toBeNull();
  });
});
