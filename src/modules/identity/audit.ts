import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

/**
 * Append-only audit repository (T098, SR-005).
 *
 * Financial, authorization, supplier, delivery, and manual-review transitions
 * create attributable, immutable audit evidence. This repository exposes ONLY
 * append and read — there is no update or delete path, so an audit row cannot be
 * mutated after the fact. Payloads are allowlisted/redacted; a raw secret must
 * never reach the audit trail (SR-001).
 */

export type AuditActorType = "ROOT_ADMIN" | "SYSTEM" | "SUPPLIER" | "PAYMENT_PROVIDER";

export interface AppendAuditInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  metadataRedacted?: Record<string, string | number | boolean | null>;
}

export interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  occurredAt: string;
  metadataRedacted: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  correlation_id: string;
  occurred_at: Date | string;
  metadata_redacted: Record<string, unknown> | string;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseMetadata(v: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return v;
}

function mapEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    correlationId: row.correlation_id,
    occurredAt: toIso(row.occurred_at),
    metadataRedacted: parseMetadata(row.metadata_redacted),
  };
}

/**
 * Append an immutable audit event. A non-empty reason is mandatory for
 * attributable evidence (FR-023); an all-whitespace reason is rejected.
 */
export async function appendAuditEvent(exec: Executor, input: AppendAuditInput): Promise<string> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("audit reason must not be empty");
  }
  const id = newId();
  const metadata = JSON.stringify(input.metadataRedacted ?? {});
  await sql`
    insert into audit_event
      (id, actor_type, actor_id, action, target_type, target_id, reason,
       before_hash, after_hash, correlation_id, metadata_redacted)
    values
      (${id}, ${input.actorType}, ${input.actorId ?? null}, ${input.action},
       ${input.targetType}, ${input.targetId}, ${reason},
       ${input.beforeHash ?? null}, ${input.afterHash ?? null},
       ${input.correlationId}, ${metadata}::jsonb)
  `.execute(exec);
  return id;
}

/** Read audit events for a target, newest first. Read-only projection. */
export async function listAuditEvents(
  exec: Executor,
  input: { targetType: string; targetId: string; limit?: number },
): Promise<AuditEvent[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const result = await sql<AuditRow>`
    select id, actor_type, actor_id, action, target_type, target_id, reason,
           correlation_id, occurred_at, metadata_redacted
    from audit_event
    where target_type = ${input.targetType} and target_id = ${input.targetId}
    order by occurred_at desc, id desc
    limit ${limit}
  `.execute(exec);
  return result.rows.map(mapEvent);
}
