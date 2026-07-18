import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

/**
 * Expiring, action-bound AdminConfirmation aggregate (T096, FR-023).
 *
 * A high-risk owner action mints a short-lived challenge whose hash is bound to
 * (root identity, action fingerprint). Confirmation requires the matching
 * challenge, refuses after expiry, and can be consumed at most once. The
 * plaintext challenge is returned only on issue — storage holds only the hash.
 *
 * State: CREATED -> CONFIRMED -> CONSUMED
 *        CREATED/CONFIRMED -> EXPIRED
 *        any active -> REVOKED
 */

export type ConfirmationStatus = "CREATED" | "CONFIRMED" | "CONSUMED" | "EXPIRED" | "REVOKED";

export type ConfirmErrorCode =
  | "NOT_FOUND"
  | "ACTION_MISMATCH"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_MISMATCH"
  | "ALREADY_CONSUMED"
  | "NOT_ACTIVE"
  | "NOT_ROOT";

export const DURABLE_ADMIN_COMMAND_REFS = ["discrepancy.resolve"] as const;
export type DurableAdminCommandRef = (typeof DURABLE_ADMIN_COMMAND_REFS)[number];

export interface DurableAdminAction {
  commandRef: DurableAdminCommandRef;
  payloadRedacted: Record<string, unknown>;
  correlationId: string;
  actionFingerprint: string;
}

export function isDurableAdminCommandRef(value: string): value is DurableAdminCommandRef {
  return (DURABLE_ADMIN_COMMAND_REFS as readonly string[]).includes(value);
}

export interface IssueInput {
  rootChannelIdentityId: string;
  actionFingerprint: string;
  correlationId: string;
  ttlSeconds?: number;
  allowlistedCommandRef?: DurableAdminCommandRef;
  payloadRedacted?: Record<string, unknown>;
}

export type IssueResult =
  | {
      ok: true;
      confirmationId: string;
      challenge: string;
      expiresAt: string;
      actionFingerprint: string;
    }
  | { ok: false; code: "INVALID_INPUT"; message: string };

export interface ConfirmInput {
  confirmationId: string;
  rootChannelIdentityId: string;
  actionFingerprint: string;
  challenge: string;
}

export type ConfirmResult =
  | { ok: true; confirmationId: string; status: "CONFIRMED" }
  | { ok: false; code: ConfirmErrorCode; message: string };

export interface ConsumeInput {
  confirmationId: string;
  rootChannelIdentityId: string;
  actionFingerprint: string;
}

export type ConsumeResult =
  | { ok: true; confirmationId: string; status: "CONSUMED" }
  | { ok: false; code: ConfirmErrorCode; message: string };

export interface AdminConfirmationService {
  issue(input: IssueInput): Promise<IssueResult>;
  confirm(input: ConfirmInput): Promise<ConfirmResult>;
  /** Aggregate-only transition. Domain mutations must use executeAtomically. */
  consume(input: ConsumeInput): Promise<ConsumeResult>;
  /** Confirm, apply the allowlisted command, append audit, and consume in one transaction. */
  executeAtomically(input: AtomicExecuteInput): Promise<AtomicExecuteResult>;
}

export interface AtomicExecuteInput {
  confirmationId: string;
  rootChannelIdentityId: string;
  challenge: string;
  execute: (trx: Trx, action: DurableAdminAction) => Promise<boolean>;
}

export type AtomicExecuteResult =
  | {
      ok: true;
      confirmationId: string;
      status: "CONSUMED";
      action: DurableAdminAction;
      alreadyConsumed: boolean;
    }
  | {
      ok: false;
      code: ConfirmErrorCode | "MISSING_ACTION" | "TARGET_NOT_FOUND";
      message: string;
    };

export interface AdminConfirmationOptions {
  now?: () => Date;
  defaultTtlSeconds?: number;
}

interface ConfirmationRow {
  id: string;
  root_channel_identity_id: string;
  action_fingerprint: string;
  challenge_hash: string;
  status: ConfirmationStatus;
  expires_at: Date | string;
  confirmed_at: Date | string | null;
  consumed_at: Date | string | null;
  correlation_id: string;
  allowlisted_command_ref: string | null;
  payload_redacted: Record<string, unknown> | string;
}

const DEFAULT_TTL_SECONDS = 120;
const MAX_DURABLE_PAYLOAD_BYTES = 4_096;

class AtomicActionNotAppliedError extends Error {}

function hashChallenge(challenge: string): string {
  return createHash("sha256").update(challenge, "utf8").digest("hex");
}

function mintChallenge(): string {
  return randomBytes(24).toString("base64url");
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function parsePayloadRedacted(
  value: Record<string, unknown> | string,
): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return value !== null && !Array.isArray(value) ? value : null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function findConfirmation(
  exec: Executor,
  confirmationId: string,
  lock = false,
): Promise<ConfirmationRow | null> {
  const lockClause = lock ? sql`for update` : sql``;
  const result = await sql<ConfirmationRow>`
    select id, root_channel_identity_id, action_fingerprint, challenge_hash, status,
           expires_at, confirmed_at, consumed_at, correlation_id,
           allowlisted_command_ref, payload_redacted
    from admin_confirmation
    where id = ${confirmationId}
    limit 1
    ${lockClause}
  `.execute(exec);
  return result.rows[0] ?? null;
}

function durableActionFrom(row: ConfirmationRow): DurableAdminAction | null {
  const commandRef = row.allowlisted_command_ref;
  const payloadRedacted = parsePayloadRedacted(row.payload_redacted);
  if (commandRef === null || !isDurableAdminCommandRef(commandRef) || payloadRedacted === null) {
    return null;
  }
  return {
    commandRef,
    payloadRedacted,
    correlationId: row.correlation_id,
    actionFingerprint: row.action_fingerprint,
  };
}

/**
 * Create an AdminConfirmation service bound to a database handle.
 * Prefer the free helpers `issueConfirmation` / `consumeConfirmation` when a
 * one-shot call is enough; the service is useful for injection into callbacks.
 */
export function createAdminConfirmation(
  db: Db,
  options: AdminConfirmationOptions = {},
): AdminConfirmationService {
  const clock = options.now ?? (() => new Date());
  const defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;

  return {
    async issue(input) {
      if (!input.rootChannelIdentityId || !input.actionFingerprint) {
        return { ok: false, code: "INVALID_INPUT", message: "identity and fingerprint required" };
      }
      const commandRef = input.allowlistedCommandRef ?? null;
      const hasPayload = input.payloadRedacted !== undefined;
      if (
        (commandRef === null) !== !hasPayload ||
        (commandRef !== null && !isDurableAdminCommandRef(commandRef))
      ) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          message: "durable command and payload must be supplied together and allowlisted",
        };
      }
      const payloadJson = JSON.stringify(input.payloadRedacted ?? {});
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_DURABLE_PAYLOAD_BYTES) {
        return { ok: false, code: "INVALID_INPUT", message: "durable payload is too large" };
      }
      const ttl = Math.max(15, Math.min(input.ttlSeconds ?? defaultTtl, 900));
      const confirmationId = newId();
      const challenge = mintChallenge();
      const challengeHash = hashChallenge(challenge);
      const now = clock();
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      // Invalidate any prior live challenge for the same (root, fingerprint) so
      // the unique partial index never collides with a stale CREATED row.
      await withTransaction(db, async (trx) => {
        await sql`
          update admin_confirmation
          set status = 'REVOKED'
          where root_channel_identity_id = ${input.rootChannelIdentityId}
            and action_fingerprint = ${input.actionFingerprint}
            and status in ('CREATED', 'CONFIRMED')
        `.execute(trx);

        await sql`
          insert into admin_confirmation
            (id, root_channel_identity_id, action_fingerprint, challenge_hash,
             status, expires_at, correlation_id, allowlisted_command_ref, payload_redacted)
          values
            (${confirmationId}, ${input.rootChannelIdentityId}, ${input.actionFingerprint},
             ${challengeHash}, 'CREATED', ${expiresAt.toISOString()}, ${input.correlationId},
             ${commandRef}, ${payloadJson}::jsonb)
        `.execute(trx);
      });

      return {
        ok: true,
        confirmationId,
        challenge,
        expiresAt: expiresAt.toISOString(),
        actionFingerprint: input.actionFingerprint,
      };
    },

    async confirm(input) {
      const row = await findConfirmation(db, input.confirmationId);
      if (!row) {
        return { ok: false, code: "NOT_FOUND", message: "confirmation not found" };
      }
      if (row.root_channel_identity_id !== input.rootChannelIdentityId) {
        return { ok: false, code: "NOT_ROOT", message: "identity mismatch" };
      }
      if (row.action_fingerprint !== input.actionFingerprint) {
        return { ok: false, code: "ACTION_MISMATCH", message: "action fingerprint mismatch" };
      }
      if (row.status === "CONSUMED") {
        return { ok: false, code: "ALREADY_CONSUMED", message: "already consumed" };
      }
      if (row.status === "REVOKED" || row.status === "EXPIRED") {
        return { ok: false, code: "NOT_ACTIVE", message: `status is ${row.status}` };
      }
      if (row.status !== "CREATED" && row.status !== "CONFIRMED") {
        return { ok: false, code: "NOT_ACTIVE", message: `status is ${row.status}` };
      }

      const now = clock();
      const expiresAt = new Date(toIso(row.expires_at));
      if (now.getTime() > expiresAt.getTime()) {
        await sql`
          update admin_confirmation set status = 'EXPIRED'
          where id = ${row.id} and status in ('CREATED', 'CONFIRMED')
        `.execute(db);
        return { ok: false, code: "CHALLENGE_EXPIRED", message: "challenge expired" };
      }

      const presented = hashChallenge(input.challenge);
      if (!safeEqualHex(presented, row.challenge_hash)) {
        return { ok: false, code: "CHALLENGE_MISMATCH", message: "challenge mismatch" };
      }

      // Idempotent: already CONFIRMED with matching challenge is a success.
      if (row.status === "CONFIRMED") {
        return { ok: true, confirmationId: row.id, status: "CONFIRMED" };
      }

      await sql`
        update admin_confirmation
        set status = 'CONFIRMED', confirmed_at = ${now.toISOString()}
        where id = ${row.id} and status = 'CREATED'
      `.execute(db);

      return { ok: true, confirmationId: row.id, status: "CONFIRMED" };
    },

    async consume(input) {
      const row = await findConfirmation(db, input.confirmationId);
      if (!row) {
        return { ok: false, code: "NOT_FOUND", message: "confirmation not found" };
      }
      if (row.root_channel_identity_id !== input.rootChannelIdentityId) {
        return { ok: false, code: "NOT_ROOT", message: "identity mismatch" };
      }
      if (row.action_fingerprint !== input.actionFingerprint) {
        return { ok: false, code: "ACTION_MISMATCH", message: "action fingerprint mismatch" };
      }
      if (row.status === "CONSUMED") {
        // Idempotent re-entry for a crash between consume and the domain write.
        return { ok: true, confirmationId: row.id, status: "CONSUMED" };
      }
      if (row.status !== "CONFIRMED") {
        return {
          ok: false,
          code: row.status === "CREATED" ? "NOT_ACTIVE" : "NOT_ACTIVE",
          message: `cannot consume from status ${row.status}`,
        };
      }

      const now = clock();
      const expiresAt = new Date(toIso(row.expires_at));
      if (now.getTime() > expiresAt.getTime()) {
        await sql`
          update admin_confirmation set status = 'EXPIRED'
          where id = ${row.id} and status = 'CONFIRMED'
        `.execute(db);
        return { ok: false, code: "CHALLENGE_EXPIRED", message: "challenge expired" };
      }

      await sql`
        update admin_confirmation
        set status = 'CONSUMED', consumed_at = ${now.toISOString()}
        where id = ${row.id} and status = 'CONFIRMED'
      `.execute(db);

      return { ok: true, confirmationId: row.id, status: "CONSUMED" };
    },

    async executeAtomically(input) {
      try {
        return await withTransaction(db, async (trx): Promise<AtomicExecuteResult> => {
          const row = await findConfirmation(trx, input.confirmationId, true);
          if (!row) {
            return { ok: false, code: "NOT_FOUND", message: "confirmation not found" };
          }
          if (row.root_channel_identity_id !== input.rootChannelIdentityId) {
            return { ok: false, code: "NOT_ROOT", message: "identity mismatch" };
          }

          const action = durableActionFrom(row);
          if (!action) {
            return { ok: false, code: "MISSING_ACTION", message: "durable action is unavailable" };
          }

          const presented = hashChallenge(input.challenge);
          if (!safeEqualHex(presented, row.challenge_hash)) {
            return { ok: false, code: "CHALLENGE_MISMATCH", message: "challenge mismatch" };
          }

          if (row.status === "CONSUMED") {
            return {
              ok: true,
              confirmationId: row.id,
              status: "CONSUMED",
              action,
              alreadyConsumed: true,
            };
          }
          if (row.status === "REVOKED" || row.status === "EXPIRED") {
            return { ok: false, code: "NOT_ACTIVE", message: `status is ${row.status}` };
          }
          if (row.status !== "CREATED" && row.status !== "CONFIRMED") {
            return { ok: false, code: "NOT_ACTIVE", message: `status is ${row.status}` };
          }

          const now = clock();
          const expiresAt = new Date(toIso(row.expires_at));
          if (now.getTime() > expiresAt.getTime()) {
            await sql`
              update admin_confirmation set status = 'EXPIRED'
              where id = ${row.id} and status in ('CREATED', 'CONFIRMED')
            `.execute(trx);
            return { ok: false, code: "CHALLENGE_EXPIRED", message: "challenge expired" };
          }

          if (row.status === "CREATED") {
            const confirmed = await sql<{ id: string }>`
              update admin_confirmation
              set status = 'CONFIRMED', confirmed_at = ${now.toISOString()}
              where id = ${row.id} and status = 'CREATED'
              returning id
            `.execute(trx);
            if (confirmed.rows.length !== 1) {
              throw new Error("admin confirmation atomic confirm lost its row lock");
            }
          }

          if (!(await input.execute(trx, action))) {
            throw new AtomicActionNotAppliedError("durable admin target was not found");
          }

          const consumed = await sql<{ id: string }>`
            update admin_confirmation
            set status = 'CONSUMED',
                confirmed_at = coalesce(confirmed_at, ${now.toISOString()}),
                consumed_at = ${now.toISOString()}
            where id = ${row.id} and status = 'CONFIRMED'
            returning id
          `.execute(trx);
          if (consumed.rows.length !== 1) {
            throw new Error("admin confirmation atomic consume lost its row lock");
          }

          return {
            ok: true,
            confirmationId: row.id,
            status: "CONSUMED",
            action,
            alreadyConsumed: false,
          };
        });
      } catch (error) {
        if (error instanceof AtomicActionNotAppliedError) {
          return { ok: false, code: "TARGET_NOT_FOUND", message: error.message };
        }
        throw error;
      }
    },
  };
}

/** Convenience free-function wrappers used by the integration tests. */
export async function issueConfirmation(
  svc: AdminConfirmationService,
  input: IssueInput,
): Promise<IssueResult> {
  return svc.issue(input);
}

export async function consumeConfirmation(
  svc: AdminConfirmationService,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  return svc.consume(input);
}
