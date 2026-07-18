import { AppError } from "../../shared/errors/index.js";
import { newId, type AuditId } from "../../shared/ids/index.js";
import { nowUtc } from "../../shared/time/index.js";

/**
 * Audit evidence builder (SR-005) with a secret tripwire (SR-001).
 *
 * Financial, authorization, supplier, delivery, and manual-review transitions
 * must produce attributable, immutable audit rows: actor, action, target,
 * reason, correlation id, time — plus only *references* in metadata, never raw
 * secrets. `assertNoRawSecret` scans the metadata graph and refuses to build a
 * record that smuggles a credential-like field, so a careless caller fails
 * loudly instead of persisting a secret into the append-only audit log.
 */

export class AuditRedactionError extends AppError {
  constructor(path: string) {
    super("VALIDATION", "Audit metadata must not contain raw secrets", { path });
    this.name = "AuditRedactionError";
  }
}

/** Lowercased key fragments that indicate a raw secret rather than a reference. */
const FORBIDDEN_KEY_FRAGMENTS = [
  "token",
  "secret",
  "credential",
  "password",
  "apikey",
  "api_key",
  "private_key",
  "privatekey",
];

// A `*_ref` / `*_id` key is a reference, not the secret itself — allow it.
function isReferenceKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith("_ref") || k.endsWith("ref") || k.endsWith("_id") || k.endsWith("id");
}

function keyLooksSecret(key: string): boolean {
  const k = key.toLowerCase();
  if (isReferenceKey(k)) return false;
  return FORBIDDEN_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

/**
 * Recursively assert no object key looks like a raw secret. Throws
 * {@link AuditRedactionError} with the offending path on the first hit.
 */
export function assertNoRawSecret(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoRawSecret(item, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keyLooksSecret(key)) {
      throw new AuditRedactionError(`${path}.${key}`);
    }
    assertNoRawSecret(child, `${path}.${key}`);
  }
}

export type AuditActorType = "customer" | "root_admin" | "system" | "provider" | "worker";

export interface AuditInput {
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  correlationId: string;
  beforeHash?: string;
  afterHash?: string;
  metadata?: Record<string, unknown>;
}

/** Persisted audit row shape (snake_case, mirrors the migration). */
export interface AuditRecord {
  id: AuditId;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  before_hash: string | null;
  after_hash: string | null;
  correlation_id: string;
  occurred_at: string;
  metadata_redacted: Record<string, unknown>;
}

/**
 * Build an attributable audit record. Validates the metadata carries no raw
 * secret before returning; the caller persists the result inside the same
 * transaction as the domain transition it evidences.
 */
export function buildAuditRecord(input: AuditInput): AuditRecord {
  const metadata = input.metadata ?? {};
  assertNoRawSecret(metadata);

  return {
    id: newId<AuditId>(),
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    reason: input.reason,
    before_hash: input.beforeHash ?? null,
    after_hash: input.afterHash ?? null,
    correlation_id: input.correlationId,
    occurred_at: nowUtc().toISOString(),
    metadata_redacted: metadata,
  };
}
