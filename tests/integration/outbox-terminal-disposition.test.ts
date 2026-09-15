import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { enqueueOutboxEvent } from "../../src/infrastructure/outbox/repository.js";
import {
  OUTBOX_DISPOSITION_CODES,
  dispositionTerminalOutboxEvent,
  getTerminalOutboxOrphan,
  isOutboxDispositionCode,
  listTerminalOutboxOrphans,
} from "../../src/infrastructure/outbox/disposition.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Slice B — terminal outbox-orphan disposition.
 *
 * A dead letter is evidence: the position here is that closing one records the
 * operator's decision while the original payload, attempt count, error code and
 * dead-letter stamp stay exactly as the drainer left them. A row that is still
 * retrying must never be closed by hand.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table outbox_event, audit_event cascade`.execute(ctx.db);
});

interface OrphanFixture {
  eventId: string;
  payload: Record<string, unknown>;
}

/** A dead-lettered orphan: 4 attempts, last failure retained, unpublished. */
async function seedOrphan(overrides: { attempts?: number; errorCode?: string } = {}) {
  const eventId = newId();
  const payload = { orderId: newId(), correlationId: "corr-orphan" };
  await enqueueOutboxEvent(ctx.db, {
    id: eventId,
    aggregateType: "Order",
    aggregateId: newId(),
    aggregateVersion: 2,
    eventType: "DeliveryBundleCreated",
    payloadRedacted: payload,
  });
  await sql`
    update outbox_event
    set attempt_count = ${overrides.attempts ?? 4},
        last_error_code = ${overrides.errorCode ?? "DELIVERY_HANDOFF_NOT_READY"},
        next_attempt_at = now() + interval '1 hour',
        dead_lettered_at = now()
    where id = ${eventId}
  `.execute(ctx.db);
  return { eventId, payload } satisfies OrphanFixture;
}

async function seedRetryingEvent() {
  const eventId = newId();
  await enqueueOutboxEvent(ctx.db, {
    id: eventId,
    aggregateType: "Order",
    aggregateId: newId(),
    aggregateVersion: 2,
    eventType: "OrderPaid",
    payloadRedacted: { orderId: newId() },
  });
  await sql`
    update outbox_event
    set attempt_count = 1, last_error_code = 'OUT_OF_STOCK', next_attempt_at = now() + interval '2 seconds'
    where id = ${eventId}
  `.execute(ctx.db);
  return eventId;
}

/** The evidence the disposition must never rewrite. */
async function preservedEvidence(eventId: string) {
  const row = await sql<{
    payload_redacted: Record<string, unknown>;
    attempt_count: number;
    last_error_code: string | null;
    dead_lettered_at: Date | null;
    published_at: Date | null;
    next_attempt_at: Date | null;
  }>`
    select payload_redacted, attempt_count, last_error_code, dead_lettered_at, published_at, next_attempt_at
    from outbox_event where id = ${eventId}
  `.execute(ctx.db);
  return row.rows[0]!;
}

async function auditRows(eventId: string) {
  const rows = await sql<{
    action: string;
    reason: string;
    metadata_redacted: Record<string, unknown>;
  }>`
    select action, reason, metadata_redacted from audit_event
    where target_type = 'OutboxEvent' and target_id = ${eventId}
    order by occurred_at asc
  `.execute(ctx.db);
  return rows.rows;
}

describe("terminal outbox orphans", () => {
  it("accepts only the bounded disposition vocabulary", () => {
    for (const code of OUTBOX_DISPOSITION_CODES) {
      expect(isOutboxDispositionCode(code)).toBe(true);
    }
    expect(isOutboxDispositionCode("WHATEVER")).toBe(false);
  });

  it("lists dead letters with their attempt and error evidence, and hides retrying rows", async () => {
    const orphan = await seedOrphan();
    const retrying = await seedRetryingEvent();

    const listed = await listTerminalOutboxOrphans(ctx.db, 10);
    expect(listed.map((row) => row.id)).toEqual([orphan.eventId]);
    expect(listed[0]).toMatchObject({
      eventType: "DeliveryBundleCreated",
      attemptCount: 4,
      lastErrorCode: "DELIVERY_HANDOFF_NOT_READY",
      dispositionStatus: null,
    });
    expect(listed.map((row) => row.id)).not.toContain(retrying);
  });

  it("returns the original payload verbatim for review", async () => {
    const orphan = await seedOrphan();
    const detail = await getTerminalOutboxOrphan(ctx.db, orphan.eventId);
    expect(detail?.payloadRedacted).toEqual(orphan.payload);
    expect(await getTerminalOutboxOrphan(ctx.db, newId())).toBeNull();
  });

  it("refuses to close an event that is still retrying", async () => {
    const retrying = await seedRetryingEvent();
    const result = await dispositionTerminalOutboxEvent(ctx.db, {
      eventId: retrying,
      expectedVersion: 1,
      code: "NO_LONGER_APPLICABLE",
      note: "Đơn đã hủy",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-retry",
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_TERMINAL" });
    const evidence = await preservedEvidence(retrying);
    expect(evidence.published_at).toBeNull();
    expect(evidence.dead_lettered_at).toBeNull();
    expect(await auditRows(retrying)).toHaveLength(0);
  });

  it("closes an orphan while preserving payload, attempts and error evidence", async () => {
    const orphan = await seedOrphan();
    const before = await preservedEvidence(orphan.eventId);

    const result = await dispositionTerminalOutboxEvent(ctx.db, {
      eventId: orphan.eventId,
      expectedVersion: 1,
      code: "HANDLED_MANUALLY",
      note: "Đã giao thủ công cho khách",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-close",
    });
    expect(result).toMatchObject({ ok: true, kind: "DISPOSITIONED", version: 2 });
    expect(await listTerminalOutboxOrphans(ctx.db, 10)).toHaveLength(0);

    const after = await preservedEvidence(orphan.eventId);
    expect(after).toEqual(before);
    expect(after.published_at).toBeNull();

    const row = await sql<{
      disposition_status: string | null;
      disposition_code: string | null;
      dispositioned_by: string | null;
      dispositioned_at: Date | null;
      disposition_version: number;
    }>`
      select disposition_status, disposition_code, dispositioned_by, dispositioned_at, disposition_version
      from outbox_event where id = ${orphan.eventId}
    `.execute(ctx.db);
    expect(row.rows[0]).toMatchObject({
      disposition_status: "RESOLVED",
      disposition_code: "HANDLED_MANUALLY",
      dispositioned_by: "1001",
      disposition_version: 2,
    });
    expect(row.rows[0]?.dispositioned_at).toBeInstanceOf(Date);

    // The audit is what makes the closure attributable; it carries the redacted
    // decision context and never the event payload.
    const audits = await auditRows(orphan.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("outbox.orphan_disposed");
    expect(audits[0]?.metadata_redacted).toMatchObject({
      dispositionCode: "HANDLED_MANUALLY",
      eventType: "DeliveryBundleCreated",
      attemptCount: 4,
    });
    expect(JSON.stringify(audits[0]?.metadata_redacted)).not.toContain(
      String(orphan.payload.orderId),
    );
  });

  it("is idempotent for a replayed confirmation and rejects a conflicting repeat", async () => {
    const orphan = await seedOrphan();
    const requestId = newId();
    const input = {
      eventId: orphan.eventId,
      expectedVersion: 1,
      code: "NO_LONGER_APPLICABLE" as const,
      note: "Đơn đã hết hạn xử lý",
      requestId,
      actorId: "1001",
      correlationId: "corr-replay",
    };

    expect(await dispositionTerminalOutboxEvent(ctx.db, input)).toMatchObject({
      ok: true,
      kind: "DISPOSITIONED",
      version: 2,
    });
    expect(await dispositionTerminalOutboxEvent(ctx.db, input)).toMatchObject({
      ok: true,
      kind: "REPLAYED",
      version: 2,
      auditEventId: null,
    });
    expect(await auditRows(orphan.eventId)).toHaveLength(1);

    const conflicting = await dispositionTerminalOutboxEvent(ctx.db, {
      ...input,
      code: "ESCALATED",
    });
    expect(conflicting).toMatchObject({ ok: false, code: "CONFLICTING_REPEAT" });

    const secondDecision = await dispositionTerminalOutboxEvent(ctx.db, {
      ...input,
      requestId: newId(),
      code: "ESCALATED",
    });
    expect(secondDecision).toMatchObject({ ok: false, code: "ALREADY_DISPOSITIONED" });
  });

  it("rejects a stale version and an unknown event id", async () => {
    const orphan = await seedOrphan();
    const stale = await dispositionTerminalOutboxEvent(ctx.db, {
      eventId: orphan.eventId,
      expectedVersion: 7,
      code: "ESCALATED",
      note: "Chuyển kỹ thuật",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-stale",
    });
    expect(stale).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });

    const missing = await dispositionTerminalOutboxEvent(ctx.db, {
      eventId: newId(),
      expectedVersion: 1,
      code: "ESCALATED",
      note: "Chuyển kỹ thuật",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-missing",
    });
    expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const blankNote = await dispositionTerminalOutboxEvent(ctx.db, {
      eventId: orphan.eventId,
      expectedVersion: 1,
      code: "ESCALATED",
      note: "  ",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-note",
    });
    expect(blankNote).toMatchObject({ ok: false, code: "INVALID_NOTE" });

    expect(await auditRows(orphan.eventId)).toHaveLength(0);
  });
});
