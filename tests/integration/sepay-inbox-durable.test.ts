import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import {
  createPostgresSePayInbox,
  processSePayInboxBatch,
  type SePayInboxEnvelope,
} from "../../src/infrastructure/inbox/sepay.js";
import { isVerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const envelope: SePayInboxEnvelope = {
  evidence: {
    provider: "sepay",
    providerTransactionId: "123456",
    direction: "IN",
    merchantAccountId: "0123456789",
    amountVnd: 150000,
    structuredCode: "ORD123",
    content: "free form content",
    reference: "FT123",
    transactedAt: "2026-07-17T05:00:00.000Z",
    rawHash: "a".repeat(64),
    correlationId: "sepay:123456",
  },
  payload: {
    id: 123456,
    gateway: "MBBank",
    transactionDate: "2026-07-17 12:00:00",
    accountNumber: "0123456789",
    subAccount: null,
    code: "ORD123",
    content: "free form content",
    transferType: "in",
    description: null,
    transferAmount: 150000,
    accumulated: 500000,
    referenceCode: "FT123",
  },
  auth: {
    timestamp: "1752728400",
    signatureHash: "b".repeat(64),
    sourceIp: "172.236.138.20",
  },
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table discrepancy, webhook_inbox cascade`.execute(ctx.db);
});

describe("durable SePay inbox", () => {
  it("dedupes identical events and records a security discrepancy for mutated replay", async () => {
    const inbox = createPostgresSePayInbox(ctx.db);
    expect(
      await inbox.accept({ sourceEventId: "123456", rawHash: "a".repeat(64), envelope }),
    ).toMatchObject({ kind: "ACCEPTED" });
    expect(
      await inbox.accept({ sourceEventId: "123456", rawHash: "a".repeat(64), envelope }),
    ).toMatchObject({ kind: "DUPLICATE" });
    for (let replay = 0; replay < 20; replay += 1) {
      expect(
        await inbox.accept({
          sourceEventId: "123456",
          rawHash: "c".repeat(64),
          envelope: { ...envelope, evidence: { ...envelope.evidence, rawHash: "c".repeat(64) } },
        }),
      ).toMatchObject({ kind: "MUTATION" });
    }

    const row = await sql<{
      processing_status: string;
      mutation_count: number;
      has_raw_body: boolean;
    }>`
      select processing_status, mutation_count, envelope ? 'rawBody' as has_raw_body
      from webhook_inbox where source = 'sepay' and source_event_id = '123456'
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({
      processing_status: "RETRY",
      mutation_count: 20,
      has_raw_body: false,
    });
    const alerts = await sql<{ count: number }>`
      select count(*)::int as count from discrepancy
      where type = 'REFERENCE_COLLISION' and owner = 'payments-security'
    `.execute(ctx.db);
    expect(alerts.rows[0]?.count).toBe(1);
    await expect(
      sql`update webhook_inbox set envelope = jsonb_set(envelope, '{evidence,content}', '"tampered"')
          where source = 'sepay' and source_event_id = '123456'`.execute(ctx.db),
    ).rejects.toThrow(/immutable/i);
  });

  it("survives the ACK boundary and applies the immutable evidence in the worker", async () => {
    const inbox = createPostgresSePayInbox(ctx.db);
    await inbox.accept({ sourceEventId: "123456", rawHash: "a".repeat(64), envelope });
    const handler = vi.fn().mockImplementation(async (evidence) => {
      expect(isVerifiedSePayEvidence(evidence)).toBe(true);
      expect(evidence.structuredCode).toBe("ORD123");
      return { ok: true };
    });
    const result = await processSePayInboxBatch({
      inbox,
      handler,
      owner: "sepay-worker-test",
      batchSize: 10,
    });
    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0, stale: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    const status = await sql<{ processing_status: string }>`
      select processing_status from webhook_inbox
      where source = 'sepay' and source_event_id = '123456'
    `.execute(ctx.db);
    expect(status.rows[0]?.processing_status).toBe("PROCESSED");
  });

  it("carries rawHash and rejects a hash-bound envelope before restoring trust", async () => {
    const inbox = createPostgresSePayInbox(ctx.db);
    await inbox.accept({
      sourceEventId: "123456",
      rawHash: "a".repeat(64),
      envelope: { ...envelope, evidence: { ...envelope.evidence, rawHash: "b".repeat(64) } },
    });
    const claims = await inbox.claimDue({ owner: "strict-worker", batchSize: 1, leaseSeconds: 30 });
    expect(claims[0]?.rawHash).toBe("a".repeat(64));
    await sql`update webhook_inbox set claim_expires_at = now() - interval '1 second'
      where source = 'sepay' and source_event_id = '123456'`.execute(ctx.db);
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await processSePayInboxBatch({
      inbox,
      handler,
      owner: "strict-worker",
      batchSize: 1,
      maxAttempts: 1,
    });
    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1, stale: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease with a new generation and dead-letters a poison claim", async () => {
    const inbox = createPostgresSePayInbox(ctx.db);
    await inbox.accept({ sourceEventId: "123456", rawHash: "a".repeat(64), envelope });
    const first = (
      await inbox.claimDue({ owner: "crashed-worker", batchSize: 1, leaseSeconds: 1 })
    )[0]!;
    await sql`update webhook_inbox set claim_expires_at = now() - interval '1 second'
      where source = 'sepay' and source_event_id = '123456'`.execute(ctx.db);
    const second = (
      await inbox.claimDue({ owner: "restarted-worker", batchSize: 1, leaseSeconds: 30 })
    )[0]!;
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(await inbox.markProcessed(first)).toBe(false);
    expect(
      await inbox.markFailed(second, { errorCode: "POISON", maxAttempts: 1, retryAfterSeconds: 0 }),
    ).toBe("DEAD");
    const row = await sql<{ processing_status: string; attempt_count: number }>`
      select processing_status, attempt_count from webhook_inbox
      where source = 'sepay' and source_event_id = '123456'
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({ processing_status: "DEAD", attempt_count: 2 });
  });

  it("dead-letters every inconsistent claimed field before the business handler", async () => {
    const inbox = createPostgresSePayInbox(ctx.db);
    const cases: Array<{ sourceEventId: string; envelope: SePayInboxEnvelope }> = [];
    const make = (id: number): SePayInboxEnvelope => ({
      ...envelope,
      evidence: {
        ...envelope.evidence,
        providerTransactionId: String(id),
        rawHash: id.toString(16).padStart(64, "0"),
      },
      payload: { ...envelope.payload, id },
    });
    const sourceMismatch = make(2002);
    cases.push({ sourceEventId: "2001", envelope: sourceMismatch });
    cases.push({
      sourceEventId: "2003",
      envelope: { ...make(2003), payload: { ...make(2003).payload, id: 2004 } },
    });
    cases.push({
      sourceEventId: "2005",
      envelope: { ...make(2005), payload: { ...make(2005).payload, accountNumber: "WRONG" } },
    });
    cases.push({
      sourceEventId: "2006",
      envelope: { ...make(2006), payload: { ...make(2006).payload, transferAmount: 1 } },
    });
    cases.push({
      sourceEventId: "2007",
      envelope: { ...make(2007), payload: { ...make(2007).payload, code: "WRONG" } },
    });
    cases.push({
      sourceEventId: "2008",
      envelope: { ...make(2008), payload: { ...make(2008).payload, content: "WRONG" } },
    });
    cases.push({
      sourceEventId: "2009",
      envelope: { ...make(2009), payload: { ...make(2009).payload, referenceCode: "WRONG" } },
    });
    cases.push({
      sourceEventId: "2010",
      envelope: { ...make(2010), evidence: { ...make(2010).evidence, transactedAt: "not-a-date" } },
    });
    cases.push({
      sourceEventId: "2011",
      envelope: { ...make(2011), auth: { ...make(2011).auth, timestamp: "0" } },
    });
    cases.push({
      sourceEventId: "2012",
      envelope: { ...make(2012), payload: { ...make(2012).payload, unexpected: true } as never },
    });

    for (const candidate of cases) {
      await inbox.accept({
        sourceEventId: candidate.sourceEventId,
        rawHash: candidate.envelope.evidence.rawHash,
        envelope: candidate.envelope,
      });
    }
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await processSePayInboxBatch({
      inbox,
      handler,
      owner: "strict-matrix-worker",
      batchSize: 20,
      maxAttempts: 1,
    });
    expect(result).toMatchObject({ claimed: cases.length, processed: 0, failed: cases.length });
    expect(handler).not.toHaveBeenCalled();
    const dead = await sql<{ count: number }>`
      select count(*)::int as count from webhook_inbox
      where source = 'sepay' and processing_status = 'DEAD'
    `.execute(ctx.db);
    expect(dead.rows[0]?.count).toBe(cases.length);
  });
});
