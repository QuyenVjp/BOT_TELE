import { sql } from "kysely";
import type { Db, Executor } from "../db/transaction.js";
import { withTransaction } from "../db/transaction.js";
import { isId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../../modules/identity/audit.js";

/**
 * Terminal outbox-orphan disposition (production-remediation slice B).
 *
 * The drainer dead-letters an event when it can never succeed (T135): the
 * domain invariant is broken (`NOT_PAID`, `NOT_FOUND`), the payload references
 * nothing dispatchable, or the attempt budget ran out. Until now a dead letter
 * was a count on the health screen — someone had to notice it and edit SQL by
 * hand.
 *
 * This is the typed API the admin command layer calls instead. It records WHAT
 * the operator decided and WHY, and it does exactly one thing: it stamps the
 * terminal disposition columns. It never publishes the event, never touches
 * `published_at`/`attempt_count`/`last_error_code`/`dead_lettered_at`, and
 * never rewrites `payload_redacted` — the original evidence stays reviewable
 * exactly as the drainer left it.
 *
 * A row that is merely retrying (not dead-lettered) is rejected: disposition
 * must never turn a retryable event into a silent success.
 */

/**
 * Bounded terminal disposition vocabulary. Each code answers "why is this
 * orphan closed?", which is what an ops report needs to query.
 */
export const OUTBOX_DISPOSITION_CODES = [
  /** The operator carried the downstream effect out by hand. */
  "HANDLED_MANUALLY",
  /** The business context is gone (order cancelled/refunded, window closed). */
  "NO_LONGER_APPLICABLE",
  /** An equivalent event already produced the effect (domain dedupe held). */
  "DUPLICATE_EVENT",
  /** The payload can never be dispatched by any worker build. */
  "INVALID_EVENT",
  /** Handed to engineering / the owner for a code fix. */
  "ESCALATED",
] as const;

export type OutboxDispositionCode = (typeof OUTBOX_DISPOSITION_CODES)[number];

/** Audit action recorded for every accepted terminal disposition. */
export const OUTBOX_DISPOSITION_AUDIT_ACTION = "outbox.orphan_disposed";

export function isOutboxDispositionCode(value: string): value is OutboxDispositionCode {
  return (OUTBOX_DISPOSITION_CODES as readonly string[]).includes(value);
}

const MAX_NOTE_LENGTH = 200;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_LIST_LIMIT = 20;

export interface TerminalOutboxOrphan {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  /** Attempt history is evidence: it is reported, never reset. */
  attemptCount: number;
  lastErrorCode: string | null;
  deadLetteredAt: string;
  occurredAt: string;
  dispositionVersion: number;
  dispositionStatus: string | null;
  dispositionCode: string | null;
  dispositionNote: string | null;
  dispositionedAt: string | null;
  dispositionedBy: string | null;
}

interface OrphanRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  attempt_count: number;
  last_error_code: string | null;
  dead_lettered_at: Date | string | null;
  occurred_at: Date | string;
  disposition_version: number;
  disposition_status: string | null;
  disposition_code: string | null;
  disposition_note: string | null;
  dispositioned_at: Date | string | null;
  dispositioned_by: string | null;
}

const ORPHAN_SELECT = sql`
  select id, aggregate_type, aggregate_id, aggregate_version, event_type,
         attempt_count, last_error_code, dead_lettered_at, occurred_at,
         disposition_version, disposition_status, disposition_code,
         disposition_note, dispositioned_at, dispositioned_by
    from outbox_event
`;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapOrphan(row: OrphanRow): TerminalOutboxOrphan {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    deadLetteredAt: toIso(row.dead_lettered_at) ?? "—",
    occurredAt: toIso(row.occurred_at) ?? "—",
    dispositionVersion: row.disposition_version,
    dispositionStatus: row.disposition_status,
    dispositionCode: row.disposition_code,
    dispositionNote: row.disposition_note,
    dispositionedAt: toIso(row.dispositioned_at),
    dispositionedBy: row.dispositioned_by,
  };
}

/**
 * The operator queue: dead-lettered, unpublished orphans, newest park first.
 * Rows already dispositioned stay visible (with their disposition) so a closed
 * orphan is reviewable rather than erased.
 */
export async function listTerminalOutboxOrphans(
  exec: Executor,
  limit = 8,
): Promise<TerminalOutboxOrphan[]> {
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_LIST_LIMIT, limit)) : 8;
  const result = await sql<OrphanRow>`
    ${ORPHAN_SELECT}
    where dead_lettered_at is not null and published_at is null
    order by dead_lettered_at desc, id
    limit ${bounded}
  `.execute(exec);
  return result.rows.map(mapOrphan);
}

export interface TerminalOutboxOrphanDetail {
  orphan: TerminalOutboxOrphan;
  /** Original emitted payload, preserved verbatim (already redacted at emit). */
  payloadRedacted: Record<string, unknown>;
}

/** One orphan with its preserved payload. Null when the id is unknown. */
export async function getTerminalOutboxOrphan(
  exec: Executor,
  eventId: string,
): Promise<TerminalOutboxOrphanDetail | null> {
  if (!isId(eventId)) return null;
  const result = await sql<OrphanRow & { payload_redacted: Record<string, unknown> }>`
    select id, aggregate_type, aggregate_id, aggregate_version, event_type,
           attempt_count, last_error_code, dead_lettered_at, occurred_at,
           disposition_version, disposition_status, disposition_code,
           disposition_note, dispositioned_at, dispositioned_by,
           payload_redacted
      from outbox_event
     where id = ${eventId}
       and dead_lettered_at is not null
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  // jsonb comes back already decoded as an object; the payload is returned as
  // stored rather than re-parsed or re-serialized, so the evidence is verbatim.
  return { orphan: mapOrphan(row), payloadRedacted: row.payload_redacted };
}

export type OutboxDispositionFailure =
  | "NOT_FOUND"
  /** Not a dead letter: a retrying event must not be closed by hand. */
  | "NOT_TERMINAL"
  | "VERSION_CONFLICT"
  /** Another confirmation already dispositioned this orphan. */
  | "ALREADY_DISPOSITIONED"
  /** Same request id, different decision (or reused on another event). */
  | "CONFLICTING_REPEAT"
  | "INVALID_CODE"
  | "INVALID_NOTE";

export type OutboxDispositionResult =
  | {
      ok: true;
      kind: "DISPOSITIONED" | "REPLAYED";
      eventId: string;
      version: number;
      /** Null on a replay: a repeated confirmation appends nothing. */
      auditEventId: string | null;
    }
  | { ok: false; code: OutboxDispositionFailure; message: string };

export interface DispositionOutboxInput {
  eventId: string;
  /** Version the operator saw, from {@link listTerminalOutboxOrphans}. */
  expectedVersion: number;
  code: OutboxDispositionCode;
  /** Operator explanation. Required, single-line, at most 200 characters. */
  note: string;
  /** Idempotency key of one operator confirmation. */
  requestId: string;
  actorId: string;
  correlationId: string;
}

interface DispositionTargetRow {
  id: string;
  event_type: string;
  attempt_count: number;
  last_error_code: string | null;
  published_at: Date | string | null;
  dead_lettered_at: Date | string | null;
  disposition_version: number;
  disposition_status: string | null;
  disposition_code: string | null;
  disposition_request_id: string | null;
}

function normalizeNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const flat = note.replace(/\s+/g, " ").trim();
  if (flat.length === 0 || flat.length > MAX_NOTE_LENGTH) return null;
  return flat;
}

/**
 * Close one dead-lettered orphan under an optimistic version guard, idempotent
 * on the request id. The caller's transaction is reused so the disposition and
 * its audit event commit together with the confirming admin command.
 */
export async function dispositionTerminalOutboxEventInTransaction(
  exec: Executor,
  input: DispositionOutboxInput,
): Promise<OutboxDispositionResult> {
  if (!isOutboxDispositionCode(input.code)) {
    return {
      ok: false,
      code: "INVALID_CODE",
      message: "Mã xử lý không nằm trong danh sách cho phép.",
    };
  }
  const note = normalizeNote(input.note);
  if (note === null) {
    return {
      ok: false,
      code: "INVALID_NOTE",
      message: `Ghi chú xử lý bắt buộc, tối đa ${MAX_NOTE_LENGTH} ký tự.`,
    };
  }
  const requestId = input.requestId?.trim() ?? "";
  if (requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
    return { ok: false, code: "CONFLICTING_REPEAT", message: "Mã yêu cầu không hợp lệ." };
  }
  if (!isId(input.eventId)) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sự kiện." };
  }

  const current = await sql<DispositionTargetRow>`
    select id, event_type, attempt_count, last_error_code, published_at, dead_lettered_at,
           disposition_version, disposition_status, disposition_code, disposition_request_id
      from outbox_event
     where id = ${input.eventId}
     for update
  `.execute(exec);
  const row = current.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sự kiện." };

  // Replay is checked before the version guard: the first attempt advanced the
  // version, so the retrying caller necessarily holds the stale one.
  if (row.disposition_request_id === requestId) {
    return row.disposition_code === input.code
      ? {
          ok: true,
          kind: "REPLAYED",
          eventId: row.id,
          version: row.disposition_version,
          auditEventId: null,
        }
      : {
          ok: false,
          code: "CONFLICTING_REPEAT",
          message: "Mã yêu cầu này đã được dùng cho một kết luận khác.",
        };
  }

  // Disposition closes a PARKED event only. A retryable row is left to the
  // drainer — closing it by hand would be a silent success for an event that
  // may still deliver.
  if (row.dead_lettered_at === null || row.published_at !== null) {
    return {
      ok: false,
      code: "NOT_TERMINAL",
      message: "Sự kiện này chưa bị treo (vẫn còn khả năng gửi lại).",
    };
  }

  // Already closed by a different confirmation: say so instead of asking the
  // operator to re-read a row that is finished (they hold a stale version, so a
  // version conflict here would be technically true but misleading).
  if (row.disposition_status !== null) {
    return {
      ok: false,
      code: "ALREADY_DISPOSITIONED",
      message: "Sự kiện này đã được xử lý.",
    };
  }

  if (
    !Number.isInteger(input.expectedVersion) ||
    row.disposition_version !== input.expectedVersion
  ) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sự kiện đã được thay đổi bởi thao tác khác. Vui lòng mở lại.",
    };
  }

  const reused = await sql<{ id: string }>`
    select id from outbox_event
    where disposition_request_id = ${requestId} and id <> ${row.id}
    limit 1
  `.execute(exec);
  if (reused.rows[0]) {
    return {
      ok: false,
      code: "CONFLICTING_REPEAT",
      message: "Mã yêu cầu này đã xử lý một sự kiện khác.",
    };
  }

  // Only the terminal disposition columns move. Payload, attempts, error code,
  // dead-letter stamp and publication state are immutable evidence.
  const updated = await sql<{ disposition_version: number }>`
    update outbox_event
    set disposition_status = 'RESOLVED',
        disposition_code = ${input.code},
        disposition_note = ${note},
        dispositioned_at = now(),
        dispositioned_by = ${input.actorId},
        disposition_request_id = ${requestId},
        disposition_version = disposition_version + 1
    where id = ${row.id}
      and dead_lettered_at is not null
      and published_at is null
      and disposition_version = ${input.expectedVersion}
    returning disposition_version
  `.execute(exec);
  const version = updated.rows[0]?.disposition_version;
  if (version === undefined) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sự kiện đã được thay đổi bởi thao tác khác. Vui lòng mở lại.",
    };
  }

  const auditEventId = await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: OUTBOX_DISPOSITION_AUDIT_ACTION,
    targetType: "OutboxEvent",
    targetId: row.id,
    reason: note,
    correlationId: input.correlationId,
    // Redacted: the code and the evidence that justified closing the orphan —
    // never the payload, which may carry customer context.
    metadataRedacted: {
      dispositionCode: input.code,
      eventType: row.event_type,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      version,
      requestId,
    },
  });

  return { ok: true, kind: "DISPOSITIONED", eventId: row.id, version, auditEventId };
}

/** Transactional entry point for callers that are not already in a unit of work. */
export async function dispositionTerminalOutboxEvent(
  db: Db,
  input: DispositionOutboxInput,
): Promise<OutboxDispositionResult> {
  return withTransaction(db, (trx) => dispositionTerminalOutboxEventInTransaction(trx, input));
}
