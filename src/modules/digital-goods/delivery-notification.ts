import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { isId, newId } from "../../shared/ids/index.js";
import { revealDeliveryBundle } from "./delivery.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import {
  issueDeliverySession,
  deliverySessionIssueConfigForVersion,
  verifyDeliverySessionToken,
  type DeliverySessionCodecConfig,
} from "./delivery-session.js";

export interface DeliveryNotificationClaim {
  id: string;
  bundleId: string;
  customerId: string;
  telegramChatId: string;
  capabilityRef: string;
  owner: string;
  generation: number;
  attemptCount: number;
  /** Non-secret commercial context for the delivery message (never credentials). */
  productName: string | null;
  usageInstructionsVi: string | null;
  warrantyVi: string | null;
}

export interface DeliveryNotificationCapability {
  deliveryUrl: string;
  sessionToken: string;
}

const DELIVERY_NOTIFICATION_LEASE_SECONDS = 30;
// External vault delete is bounded to at most 5 * 30s plus sub-second retry delay.
// Keep cleanup ownership beyond that complete adapter budget so a live delete is
// not reclaimed merely because one configured attempt consumed its full timeout.
const DELIVERY_CAPABILITY_CLEANUP_LEASE_SECONDS = 180;
const DEFAULT_DELIVERY_NOTIFICATION_SEND_TIMEOUT_MS = 25_000;
const MAX_DELIVERY_NOTIFICATION_SEND_TIMEOUT_MS = 29_000;

class DeliveryNotificationSendTimeoutError extends Error {
  override name = "DeliveryNotificationSendTimeoutError";
}
const AMBIGUOUS_DELIVERY_NOTIFICATION_SEND_ERRORS: Record<string, true> = {
  DeliveryNotificationSendTimeoutError: true,
  TelegramAmbiguousSendError: true,
};

async function sendDeliveryNotificationWithTimeout(
  sender: {
    send(input: {
      chatId: string;
      handoffId: string;
      idempotencyKey: string;
      signal: AbortSignal;
    }): Promise<void>;
  },
  input: {
    chatId: string;
    handoffId: string;
    idempotencyKey: string;
    product?: {
      name: string | null;
      usageInstructionsVi: string | null;
      warrantyVi: string | null;
    };
  },
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new DeliveryNotificationSendTimeoutError(
        "Delivery notification send exceeded its lease-safe timeout",
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([sender.send({ ...input, signal: controller.signal }), bounded]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const MAX_LEGACY_ORPHAN_CAPABILITY_REFS = 16;

type HandoffPayload = Record<string, unknown> & {
  orphanCapabilityRefs?: string[];
  refreshGeneration?: number;
  refreshExpiresAt?: number;
  refreshKeyVersion?: number;
  refreshPending?: boolean;
};

function parseHandoffPayload(value: unknown): HandoffPayload {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid delivery handoff payload");
  }
  const payload = { ...(parsed as Record<string, unknown>) } as HandoffPayload;
  const refs = payload.orphanCapabilityRefs;
  if (
    refs !== undefined &&
    (!Array.isArray(refs) ||
      refs.length > MAX_LEGACY_ORPHAN_CAPABILITY_REFS ||
      refs.some(
        (ref) =>
          typeof ref !== "string" ||
          !ref.startsWith("vault:") ||
          Buffer.byteLength(ref, "utf8") > 512,
      ))
  ) {
    throw new Error("Invalid delivery handoff orphan tombstone");
  }
  if (
    payload.refreshGeneration !== undefined &&
    (!Number.isSafeInteger(payload.refreshGeneration) || payload.refreshGeneration < 0)
  ) {
    throw new Error("Invalid delivery handoff refresh generation");
  }
  if (
    payload.refreshExpiresAt !== undefined &&
    (!Number.isSafeInteger(payload.refreshExpiresAt) || payload.refreshExpiresAt < 1)
  ) {
    throw new Error("Invalid pending delivery refresh expiry");
  }
  if (
    payload.refreshKeyVersion !== undefined &&
    (!Number.isSafeInteger(payload.refreshKeyVersion) ||
      payload.refreshKeyVersion < 0 ||
      payload.refreshKeyVersion > 255)
  ) {
    throw new Error("Invalid pending delivery refresh key version");
  }
  if (payload.refreshPending !== undefined && typeof payload.refreshPending !== "boolean") {
    throw new Error("Invalid delivery handoff refresh state");
  }
  payload.orphanCapabilityRefs = [...new Set(refs ?? [])];
  return payload;
}

function addOrphanRef(payload: HandoffPayload, ref: string): HandoffPayload {
  const refs = [...(payload.orphanCapabilityRefs ?? [])];
  if (!refs.includes(ref)) refs.push(ref);
  if (refs.length > MAX_LEGACY_ORPHAN_CAPABILITY_REFS) return payload;
  return { ...payload, orphanCapabilityRefs: refs };
}

function removeOrphanRef(payload: HandoffPayload, ref: string): HandoffPayload {
  return {
    ...payload,
    orphanCapabilityRefs: (payload.orphanCapabilityRefs ?? []).filter(
      (candidate) => candidate !== ref,
    ),
  };
}

async function mutateHandoffPayload(
  db: Db,
  handoffId: string,
  mutate: (payload: HandoffPayload) => HandoffPayload,
): Promise<void> {
  await withTransaction(db, async (trx) => {
    const row = await sql<{ payload_redacted: unknown }>`
      select payload_redacted from delivery_notification_handoff
      where id = ${handoffId}
      for update
    `.execute(trx);
    if (!row.rows[0]) throw new Error("Delivery notification handoff not found");
    const next = mutate(parseHandoffPayload(row.rows[0].payload_redacted));
    await sql`
      update delivery_notification_handoff
      set payload_redacted = ${JSON.stringify(next)}::jsonb
      where id = ${handoffId}
    `.execute(trx);
  });
}

async function tombstoneOrphanCapability(
  db: Db,
  handoffId: string,
  ref: string,
  options: { sessionId?: string; reason?: string } = {},
): Promise<void> {
  await sql`
    insert into delivery_capability_compensation
      (id, handoff_id, capability_ref, session_id, reason, status, cleanup_after)
    values
      (${newId()}, ${handoffId}, ${ref}, ${options.sessionId ?? null},
       ${options.reason ?? "VAULT_DELETE_FAILED"}, 'PENDING', now())
    on conflict (capability_ref) do update
    set session_id = coalesce(delivery_capability_compensation.session_id, excluded.session_id),
        reason = excluded.reason,
        status = case when delivery_capability_compensation.status = 'CLEANED'
          then 'PENDING' else delivery_capability_compensation.status end,
        cleanup_after = case when delivery_capability_compensation.status = 'CLEANED'
          then now() else delivery_capability_compensation.cleanup_after end,
        cleaned_at = case when delivery_capability_compensation.status = 'CLEANED'
          then null else delivery_capability_compensation.cleaned_at end
  `.execute(db);
  try {
    await mutateHandoffPayload(db, handoffId, (payload) => addOrphanRef(payload, ref));
  } catch {
    // The row ledger is authoritative; the bounded JSON field is compatibility evidence only.
  }
}

async function clearOrphanCapability(db: Db, handoffId: string, ref: string): Promise<void> {
  try {
    await mutateHandoffPayload(db, handoffId, (payload) => removeOrphanRef(payload, ref));
  } catch {
    // The handoff may already be gone; the compensation ledger still closes independently.
  }
  await sql`
    update delivery_capability_compensation
    set status = 'CLEANED', cleaned_at = now(), last_error_code = null
    where capability_ref = ${ref} and status = 'PENDING'
  `.execute(db);
}

async function revokeDeliverySession(db: Db, sessionId: string): Promise<void> {
  const removed = await sql`
    delete from delivery_session
    where id = ${sessionId} and activated_at is null and used_at is null
    returning id
  `.execute(db);
  if (removed.rows[0]) return;
  await sql`
    update delivery_session set revoked_at = coalesce(revoked_at, now())
    where id = ${sessionId} and used_at is null
  `.execute(db);
}

async function fenceCapabilityAdoption(db: Executor, ref: string): Promise<void> {
  const compensation = await sql<{ status: string }>`
    select status from delivery_capability_compensation
    where capability_ref = ${ref}
    for update
  `.execute(db);
  if (compensation.rows[0]?.status === "DELETING") {
    throw new Error("DELIVERY_CAPABILITY_CLEANUP_IN_PROGRESS");
  }
  await sql`
    update delivery_capability_compensation
    set status = 'CLEANED', cleaned_at = now(), claimed_by = null,
        claim_expires_at = null, last_error_code = null
    where capability_ref = ${ref} and status = 'PENDING'
  `.execute(db);
}

export async function createDeliveryNotificationHandoff(
  db: Db,
  input: {
    vault: Vault;
    bundleId: string;
    customerId: string;
    deliveryUrl: string;
    sessionTtlSeconds: number;
    sessionConfig: DeliverySessionCodecConfig;
  },
): Promise<{ id: string; reused: boolean }> {
  const prepared = await withTransaction(db, async (trx) => {
    const bundle = await sql<{ id: string }>`
      select id from delivery_bundle
      where id = ${input.bundleId} and customer_id = ${input.customerId}
        and status in ('CREATED','AVAILABLE','VIEWED') and expires_at > now()
      for update
    `.execute(trx);
    if (!bundle.rows[0]) throw new Error("Delivery bundle ownership mismatch");

    const identity = await sql<{ channel_user_id: string }>`
      select channel_user_id from channel_identity
      where customer_id = ${input.customerId} and channel = 'TELEGRAM'
      limit 1
    `.execute(trx);
    const telegramChatId = identity.rows[0]?.channel_user_id;
    if (!telegramChatId) throw new Error("Telegram delivery identity not found");

    const existing = await sql<{
      id: string;
      status: string;
      capability_ref: string | null;
      capability_expires_at: Date | string | null;
      session_id: string | null;
      session_key_version: number | null;
      session_generation: string;
    }>`
      select id, status, capability_ref, capability_expires_at,
        session_id, session_key_version, session_generation
      from delivery_notification_handoff
      where bundle_id = ${input.bundleId} and telegram_chat_id = ${telegramChatId}
      limit 1 for update
    `.execute(trx);
    const current = existing.rows[0];
    if (current?.capability_ref && current.status === "STORED") {
      await sql`
        update delivery_notification_handoff
        set status = 'READY', ready_at = now(), next_attempt_at = now()
        where id = ${current.id} and status = 'STORED' and capability_ref is not null
      `.execute(trx);
      return {
        id: current.id,
        reused: true as const,
        sessionToken: null,
        sessionId: null,
        telegramChatId,
      };
    }
    if (
      current?.capability_ref &&
      ["READY", "RETRY", "PROCESSING", "SENT"].includes(current.status)
    ) {
      return {
        id: current.id,
        reused: true as const,
        sessionToken: null,
        sessionId: null,
        telegramChatId,
      };
    }

    const id = current?.id ?? newId();
    const preparedSessionIsFresh =
      current?.status === "PREPARED" &&
      current.capability_expires_at !== null &&
      new Date(current.capability_expires_at).getTime() > Date.now();
    let reusePreparedSession = preparedSessionIsFresh;
    let issueConfig: DeliverySessionCodecConfig;
    if (reusePreparedSession) {
      try {
        issueConfig = deliverySessionIssueConfigForVersion(
          input.sessionConfig,
          current!.session_key_version!,
        );
      } catch {
        reusePreparedSession = false;
        issueConfig = deliverySessionIssueConfigForVersion(
          input.sessionConfig,
          input.sessionConfig.keyVersion,
        );
      }
    } else {
      issueConfig = deliverySessionIssueConfigForVersion(
        input.sessionConfig,
        input.sessionConfig.keyVersion,
      );
    }
    if (!reusePreparedSession) {
      await sql`
        delete from delivery_session
        where bundle_id = ${input.bundleId} and customer_id = ${input.customerId}
          and activated_at is null and used_at is null
      `.execute(trx);
      await sql`
        update delivery_session set revoked_at = coalesce(revoked_at, now())
        where bundle_id = ${input.bundleId} and customer_id = ${input.customerId}
          and used_at is null and revoked_at is null
      `.execute(trx);
    }
    const sessionExpiresAt = reusePreparedSession
      ? new Date(current!.capability_expires_at!)
      : new Date(Date.now() + input.sessionTtlSeconds * 1000);
    const sessionGeneration = reusePreparedSession
      ? Number(current!.session_generation)
      : Number(current?.session_generation ?? 0) + 1;
    const session = await issueDeliverySession(trx, {
      bundleId: input.bundleId,
      customerId: input.customerId,
      telegramUserId: telegramChatId,
      ttlSeconds: input.sessionTtlSeconds,
      config: issueConfig,
      idempotencyKey: `${id}-initial-${sessionGeneration}`,
      expiresAt: sessionExpiresAt,
      activate: false,
    });
    const capabilityKey = `${input.bundleId}:${telegramChatId}`;
    if (current) {
      await sql`
        update delivery_notification_handoff
        set status = 'PREPARED', capability_ref = null, stored_at = null, ready_at = null,
            capability_expires_at = ${new Date(session.claims.expiresAt * 1000).toISOString()},
            session_id = ${session.claims.sessionId},
            session_key_version = ${session.claims.keyVersion},
            session_generation = ${sessionGeneration},
            next_attempt_at = now(), last_error_code = null
        where id = ${id}
      `.execute(trx);
    } else {
      await sql`
        insert into delivery_notification_handoff
          (id, bundle_id, customer_id, telegram_chat_id, capability_key, capability_ref,
           payload_redacted, status, capability_expires_at, session_id,
           session_key_version, session_generation, next_attempt_at)
        values
          (${id}, ${input.bundleId}, ${input.customerId}, ${telegramChatId}, ${capabilityKey}, null,
           ${JSON.stringify({ bundleId: input.bundleId, customerId: input.customerId })}::jsonb,
            'PREPARED', ${new Date(session.claims.expiresAt * 1000).toISOString()},
            ${session.claims.sessionId}, ${session.claims.keyVersion}, ${sessionGeneration}, now())
      `.execute(trx);
    }
    return {
      id,
      reused: false as const,
      sessionToken: session.token,
      sessionId: session.claims.sessionId,
      sessionGeneration,
      telegramChatId,
    };
  });

  if (prepared.reused || prepared.sessionToken === null) {
    return { id: prepared.id, reused: true };
  }

  const capabilityRef = await input.vault.write(
    JSON.stringify({ deliveryUrl: input.deliveryUrl, sessionToken: prepared.sessionToken }),
    {
      namespace: "capability",
      idempotencyKey: `${prepared.id}-initial-${prepared.sessionGeneration}`,
    },
  );
  try {
    const stored = await withTransaction(db, async (trx) => {
      await fenceCapabilityAdoption(trx, capabilityRef);
      const adopted = await sql`
        update delivery_notification_handoff
        set capability_ref = ${capabilityRef}, status = 'STORED',
            stored_at = now(), next_attempt_at = now()
        where id = ${prepared.id} and status = 'PREPARED' and capability_ref is null
        returning id
      `.execute(trx);
      if (adopted.rows[0]) {
        const activated = await sql`
          update delivery_session set activated_at = coalesce(activated_at, now())
          where id = ${prepared.sessionId} and activated_at is null
            and revoked_at is null and used_at is null
          returning id
        `.execute(trx);
        if (!activated.rows[0]) throw new Error("DELIVERY_SESSION_ADOPTION_FAILED");
      }
      return adopted;
    });
    if (!stored.rows[0]) {
      const winner = await sql<{ capability_ref: string | null }>`
        select capability_ref from delivery_notification_handoff where id = ${prepared.id}
      `.execute(db);
      if (winner.rows[0]?.capability_ref === capabilityRef) {
        await clearOrphanCapability(db, prepared.id, capabilityRef);
        return { id: prepared.id, reused: true };
      }
      try {
        await input.vault.delete(capabilityRef);
      } catch {
        await tombstoneOrphanCapability(db, prepared.id, capabilityRef, {
          sessionId: prepared.sessionId,
          reason: "INITIAL_ADOPTION_LOST",
        });
      }
      return { id: prepared.id, reused: true };
    }
  } catch (error) {
    try {
      await input.vault.delete(capabilityRef);
    } catch {
      await tombstoneOrphanCapability(db, prepared.id, capabilityRef, {
        sessionId: prepared.sessionId,
        reason: "INITIAL_SWAP_AND_DELETE_FAILED",
      });
    }
    throw error;
  }
  await clearOrphanCapability(db, prepared.id, capabilityRef);
  await withTransaction(db, async (trx) => {
    await sql`
      update delivery_notification_handoff
      set status = 'READY', ready_at = now(), next_attempt_at = now()
      where id = ${prepared.id} and status = 'STORED' and capability_ref = ${capabilityRef}
    `.execute(trx);
  });
  return { id: prepared.id, reused: false };
}

export async function recoverStoredDeliveryNotificationHandoffsBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const recovered = await withTransaction(db, async (trx) =>
    sql<{ id: string }>`
      with candidates as (
        select h.id
        from delivery_notification_handoff h
        join delivery_bundle b on b.id = h.bundle_id
        where h.status = 'STORED' and h.capability_ref is not null
          and h.capability_expires_at > ${now.toISOString()}
          and b.status in ('CREATED','AVAILABLE','VIEWED') and b.expires_at > ${now.toISOString()}
        order by h.stored_at, h.id
        for update of h skip locked
        limit ${options.batchSize}
      )
      update delivery_notification_handoff h
      set status = 'READY', ready_at = ${now.toISOString()}, next_attempt_at = ${now.toISOString()}
      from candidates c where h.id = c.id
      returning h.id
    `.execute(trx),
  );
  const backlog = await sql<{ count: number; oldest: Date | string | null }>`
    select count(*)::int as count, min(stored_at) as oldest
    from delivery_notification_handoff where status = 'STORED'
  `.execute(db);
  return {
    claimed: recovered.rows.length,
    succeeded: recovered.rows.length,
    failed: 0,
    backlog: backlog.rows[0]?.count ?? 0,
    oldestAgeSeconds: ageSeconds(now, backlog.rows[0]?.oldest),
  };
}

export async function cleanupDeliveryNotificationCapabilitiesBatch(
  db: Db,
  vault: Vault,
  options: { batchSize: number; retentionSeconds: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  if (!Number.isInteger(options.retentionSeconds) || options.retentionSeconds < 0) {
    throw new Error("Invalid delivery capability retention");
  }
  const clock = options.now
    ? { now: options.now }
    : (await sql<{ now: Date | string }>`select now() as now`.execute(db)).rows[0]!;
  const now = new Date(clock.now);
  const cutoff = new Date(now.getTime() - options.retentionSeconds * 1000);
  let succeeded = 0;
  let failed = 0;
  await sql`
    with legacy as (
      select h.id as handoff_id, orphan.ref as capability_ref
      from delivery_notification_handoff h
      cross join lateral jsonb_array_elements_text(
        coalesce(h.payload_redacted -> 'orphanCapabilityRefs', '[]'::jsonb)
      ) as orphan(ref)
      where not exists (
        select 1 from delivery_capability_compensation c
        where c.capability_ref = orphan.ref
      )
      order by h.created_at, h.id, orphan.ref
      limit ${options.batchSize}
    )
    insert into delivery_capability_compensation
      (id, handoff_id, capability_ref, reason, status, cleanup_after)
    select 'legacy_' || md5(handoff_id || ':' || capability_ref),
      handoff_id, capability_ref, 'LEGACY_PAYLOAD_NORMALIZATION', 'PENDING', ${now.toISOString()}
    from legacy
    on conflict (capability_ref) do nothing
  `.execute(db);
  await withTransaction(db, async (trx) => {
    await sql`
      with terminal as (
        select h.id, h.capability_ref, h.session_id,
          coalesce(h.sent_at, h.capability_expires_at, h.created_at) as eligible_at
        from delivery_notification_handoff h
        join delivery_bundle b on b.id = h.bundle_id
        where h.capability_ref is not null and (
          (h.status in ('SENT','DEAD')
            and coalesce(h.sent_at, h.created_at) <= ${cutoff.toISOString()})
          or (h.capability_expires_at <= ${now.toISOString()}
            and b.status in ('EXPIRED','REVOKED','CONSUMED'))
        )
        order by eligible_at, h.id
        for update of h skip locked
        limit ${options.batchSize}
      ), transferred as (
        insert into delivery_capability_compensation
          (id, handoff_id, capability_ref, session_id, reason, status, cleanup_after)
        select 'terminal_' || md5(id || ':' || capability_ref), id, capability_ref,
          session_id, 'TERMINAL_HANDOFF_CLEANUP', 'PENDING', ${now.toISOString()}
        from terminal
        on conflict (capability_ref) do update
        set handoff_id = excluded.handoff_id,
            session_id = coalesce(delivery_capability_compensation.session_id, excluded.session_id),
            reason = excluded.reason,
            status = case when delivery_capability_compensation.status = 'CLEANED'
              then 'PENDING' else delivery_capability_compensation.status end,
            cleanup_after = case when delivery_capability_compensation.status = 'CLEANED'
              then excluded.cleanup_after else delivery_capability_compensation.cleanup_after end,
            cleaned_at = case when delivery_capability_compensation.status = 'CLEANED'
              then null else delivery_capability_compensation.cleaned_at end
        returning capability_ref
      )
      update delivery_notification_handoff h
      set capability_ref = null
      from terminal t
      where h.id = t.id and h.capability_ref = t.capability_ref
        and exists (
          select 1 from transferred x where x.capability_ref = t.capability_ref
        )
    `.execute(trx);
  });
  const cleanupOwner = `delivery-capability-cleanup-${newId()}`;
  const ledgerCandidates = await withTransaction(db, async (trx) =>
    sql<{
      id: string;
      handoff_id: string;
      capability_ref: string;
      session_id: string | null;
      claim_generation: string;
      attempt_count: number;
    }>`
      with due as (
        select id from delivery_capability_compensation
        where (status = 'PENDING' and cleanup_after <= ${now.toISOString()})
           or (status = 'DELETING' and claim_expires_at <= ${now.toISOString()})
        order by cleanup_after, id
        for update skip locked
        limit ${options.batchSize}
      )
      update delivery_capability_compensation c
      set status = 'DELETING', claimed_by = ${cleanupOwner},
          claim_generation = c.claim_generation + 1,
          attempt_count = c.attempt_count + 1,
          claim_expires_at = ${new Date(
            now.getTime() + DELIVERY_CAPABILITY_CLEANUP_LEASE_SECONDS * 1000,
          ).toISOString()}
      from due where c.id = due.id
      returning c.id, c.handoff_id, c.capability_ref, c.session_id,
        c.claim_generation, c.attempt_count
    `.execute(trx),
  );
  for (const candidate of ledgerCandidates.rows) {
    const generation = Number(candidate.claim_generation);
    try {
      const decision = await withTransaction(db, async (trx) => {
        const owned = await sql<{
          capability_ref: string;
          current_ref: string | null;
        }>`
          select c.capability_ref, h.capability_ref as current_ref
          from delivery_capability_compensation c
          left join delivery_notification_handoff h on h.id = c.handoff_id
          where c.id = ${candidate.id} and c.status = 'DELETING'
            and c.claimed_by = ${cleanupOwner}
            and c.claim_generation = ${generation}
          for update of c
        `.execute(trx);
        const row = owned.rows[0];
        if (!row) return "STALE" as const;
        if (row.current_ref === row.capability_ref) {
          await sql`
            update delivery_capability_compensation
            set status = 'CLEANED', cleaned_at = now(), claimed_by = null,
                claim_expires_at = null, last_error_code = null
            where id = ${candidate.id} and status = 'DELETING'
              and claimed_by = ${cleanupOwner} and claim_generation = ${generation}
          `.execute(trx);
          return "CURRENT" as const;
        }
        return "DELETE" as const;
      });
      if (decision === "STALE") continue;
      if (decision === "DELETE") {
        if (candidate.session_id) await revokeDeliverySession(db, candidate.session_id);
        await vault.delete(candidate.capability_ref);
        const cleaned = await sql`
          update delivery_capability_compensation
          set status = 'CLEANED', cleaned_at = now(), claimed_by = null,
              claim_expires_at = null, last_error_code = null
          where id = ${candidate.id} and status = 'DELETING'
            and claimed_by = ${cleanupOwner} and claim_generation = ${generation}
          returning id
        `.execute(db);
        if (!cleaned.rows[0]) throw new Error("STALE_DELIVERY_CAPABILITY_CLEANUP");
      }
      try {
        await mutateHandoffPayload(db, candidate.handoff_id, (payload) =>
          removeOrphanRef(payload, candidate.capability_ref),
        );
      } catch {
        // Ledger completion is authoritative even if the compatibility payload is gone.
      }
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const backoffSeconds = Math.min(3_600, 5 * 2 ** Math.min(candidate.attempt_count, 10));
      await sql`
        update delivery_capability_compensation
        set status = 'PENDING', claimed_by = null, claim_expires_at = null,
            cleanup_after = ${new Date(now.getTime() + backoffSeconds * 1000).toISOString()},
            last_error_code = ${error instanceof Error ? error.name.slice(0, 128) : "UNKNOWN_ERROR"}
        where id = ${candidate.id} and status = 'DELETING'
          and claimed_by = ${cleanupOwner} and claim_generation = ${generation}
      `.execute(db);
    }
  }

  const backlog = await sql<{ count: number; oldest: Date | string | null }>`
    select count(*)::int as count, min(eligible_at) as oldest
    from (
      select cleanup_after as eligible_at
      from delivery_capability_compensation
      where status in ('PENDING','DELETING')
      union all
      select h.created_at as eligible_at
      from delivery_notification_handoff h
      cross join lateral jsonb_array_elements_text(
        coalesce(h.payload_redacted -> 'orphanCapabilityRefs', '[]'::jsonb)
      ) as orphan(ref)
      where not exists (
        select 1 from delivery_capability_compensation c
        where c.capability_ref = orphan.ref
      )
      union all
      select coalesce(sent_at, capability_expires_at, created_at) as eligible_at
      from delivery_notification_handoff
      where capability_ref is not null and status in ('SENT','DEAD')
    ) pending
  `.execute(db);
  return {
    claimed: ledgerCandidates.rows.length,
    succeeded,
    failed,
    backlog: backlog.rows[0]?.count ?? 0,
    oldestAgeSeconds: ageSeconds(now, backlog.rows[0]?.oldest),
  };
}

export async function claimDeliveryNotifications(
  db: Db,
  options: { owner: string; batchSize: number; leaseSeconds: number },
): Promise<DeliveryNotificationClaim[]> {
  if (!options.owner || options.owner.length > 128) throw new Error("Invalid notification owner");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw new Error("Invalid notification batch size");
  }
  if (!Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 1) {
    throw new Error("Invalid notification lease");
  }
  const rows = await sql<{
    id: string;
    bundle_id: string;
    customer_id: string;
    telegram_chat_id: string;
    capability_ref: string;
    claimed_by: string;
    claim_generation: string;
    attempt_count: number;
    product_name: string | null;
    usage_instructions_vi: string | null;
    warranty_vi: string | null;
  }>`
    with due as (
      select id
      from delivery_notification_handoff
      where (status in ('READY','RETRY') and next_attempt_at <= now())
         or (status = 'PROCESSING' and claim_expires_at <= now())
      order by next_attempt_at, id
      for update skip locked
      limit ${options.batchSize}
    ), claimed as (
      update delivery_notification_handoff h
      set status = 'PROCESSING',
          claimed_by = ${options.owner},
          claim_generation = h.claim_generation + 1,
          claim_expires_at = now() + (${options.leaseSeconds} * interval '1 second'),
          attempt_count = h.attempt_count + 1
      from due
      where h.id = due.id
      returning h.id, h.bundle_id, h.customer_id, h.telegram_chat_id,
        h.capability_ref, h.claimed_by, h.claim_generation, h.attempt_count
    )
    select c.id, c.bundle_id, c.customer_id, c.telegram_chat_id,
      c.capability_ref, c.claimed_by, c.claim_generation, c.attempt_count,
      o.product_name_vi as product_name,
      p.usage_instructions_vi, p.warranty_vi
    from claimed c
    left join delivery_bundle b on b.id = c.bundle_id
    left join "order" o on o.id = b.order_id
    left join product_variant v on v.id = o.variant_id
    left join product p on p.id = v.product_id
  `.execute(db);
  return rows.rows.map((row) => ({
    id: row.id,
    bundleId: row.bundle_id,
    customerId: row.customer_id,
    telegramChatId: row.telegram_chat_id,
    capabilityRef: row.capability_ref,
    owner: row.claimed_by,
    generation: Number(row.claim_generation),
    attemptCount: row.attempt_count,
    productName: row.product_name,
    usageInstructionsVi: row.usage_instructions_vi,
    warrantyVi: row.warranty_vi,
  }));
}

export async function loadDeliveryNotificationCapability(
  vault: Vault,
  claim: DeliveryNotificationClaim,
): Promise<DeliveryNotificationCapability> {
  const raw = await vault.reveal(claim.capabilityRef);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid delivery notification capability");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "deliveryUrl,sessionToken") {
    throw new Error("Invalid delivery notification capability");
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.deliveryUrl !== "string" ||
    !value.deliveryUrl.startsWith("https://") ||
    typeof value.sessionToken !== "string" ||
    !value.sessionToken.startsWith("ds1.")
  ) {
    throw new Error("Invalid delivery notification capability");
  }
  return { deliveryUrl: value.deliveryUrl, sessionToken: value.sessionToken };
}

async function refreshDeliveryNotificationCapability(input: {
  db: Db;
  vault: Vault;
  claim: DeliveryNotificationClaim;
  current: DeliveryNotificationCapability;
  sessionConfig: DeliverySessionCodecConfig;
  sessionTtlSeconds: number;
}): Promise<DeliveryNotificationCapability> {
  const prepared = await withTransaction(input.db, async (trx) => {
    const owned = await sql<{ bundle_id: string; payload_redacted: unknown }>`
      select h.bundle_id, h.payload_redacted
      from delivery_notification_handoff h
      join delivery_bundle b on b.id = h.bundle_id
      where h.id = ${input.claim.id} and h.status = 'PROCESSING'
        and h.claimed_by = ${input.claim.owner}
        and h.claim_generation = ${input.claim.generation}
        and h.bundle_id = ${input.claim.bundleId}
        and h.customer_id = ${input.claim.customerId}
        and h.telegram_chat_id = ${input.claim.telegramChatId}
        and b.status in ('CREATED','AVAILABLE','VIEWED') and b.expires_at > now()
      for update of h, b
    `.execute(trx);
    const row = owned.rows[0];
    if (!row) throw new Error("STALE_DELIVERY_NOTIFICATION_CLAIM");
    const payload = parseHandoffPayload(row.payload_redacted);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const pendingRefreshIsFresh =
      payload.refreshPending === true &&
      payload.refreshGeneration !== undefined &&
      payload.refreshExpiresAt !== undefined &&
      payload.refreshKeyVersion !== undefined &&
      payload.refreshExpiresAt > nowEpoch;
    let reusePendingRefresh = pendingRefreshIsFresh;
    let issueConfig: DeliverySessionCodecConfig;
    if (reusePendingRefresh) {
      try {
        issueConfig = deliverySessionIssueConfigForVersion(
          input.sessionConfig,
          payload.refreshKeyVersion!,
        );
      } catch {
        reusePendingRefresh = false;
        issueConfig = deliverySessionIssueConfigForVersion(
          input.sessionConfig,
          input.sessionConfig.keyVersion,
        );
      }
    } else {
      issueConfig = deliverySessionIssueConfigForVersion(
        input.sessionConfig,
        input.sessionConfig.keyVersion,
      );
    }
    const refreshGeneration = reusePendingRefresh
      ? payload.refreshGeneration
      : (payload.refreshGeneration ?? 0) + 1;
    const refreshExpiresAt = reusePendingRefresh
      ? payload.refreshExpiresAt
      : nowEpoch + input.sessionTtlSeconds;
    const refreshKeyVersion = reusePendingRefresh
      ? payload.refreshKeyVersion
      : input.sessionConfig.keyVersion;
    if (!Number.isSafeInteger(refreshGeneration) || refreshGeneration! < 1) {
      throw new Error("Invalid pending delivery refresh generation");
    }
    await sql`
      update delivery_notification_handoff
      set payload_redacted = ${JSON.stringify({
        ...payload,
        refreshGeneration,
        refreshExpiresAt,
        refreshKeyVersion,
        refreshPending: true,
      })}::jsonb
      where id = ${input.claim.id}
        and claimed_by = ${input.claim.owner}
        and claim_generation = ${input.claim.generation}
    `.execute(trx);
    if (!reusePendingRefresh) {
      await sql`
        update delivery_session set revoked_at = coalesce(revoked_at, now())
        where bundle_id = ${input.claim.bundleId} and customer_id = ${input.claim.customerId}
          and used_at is null and revoked_at is null
      `.execute(trx);
    }
    const refreshOperationKey = `${input.claim.id}-refresh-${refreshGeneration}`;
    const session = await issueDeliverySession(trx, {
      bundleId: input.claim.bundleId,
      customerId: input.claim.customerId,
      telegramUserId: input.claim.telegramChatId,
      ttlSeconds: input.sessionTtlSeconds,
      config: issueConfig,
      idempotencyKey: refreshOperationKey,
      expiresAt: new Date(refreshExpiresAt! * 1000),
      activate: false,
    });
    return { session, refreshGeneration: refreshGeneration! };
  });

  const next = {
    deliveryUrl: input.current.deliveryUrl,
    sessionToken: prepared.session.token,
  };
  const nextRef = await input.vault.write(JSON.stringify(next), {
    namespace: "capability",
    idempotencyKey: `${input.claim.id}-refresh-${prepared.refreshGeneration}`,
  });
  try {
    await withTransaction(input.db, async (trx) => {
      const owned = await sql<{ payload_redacted: unknown }>`
        select payload_redacted
        from delivery_notification_handoff
        where id = ${input.claim.id} and status = 'PROCESSING'
          and claimed_by = ${input.claim.owner}
          and claim_generation = ${input.claim.generation}
          and capability_ref = ${input.claim.capabilityRef}
        for update
      `.execute(trx);
      if (!owned.rows[0]) throw new Error("STALE_DELIVERY_NOTIFICATION_CLAIM");
      let payload = parseHandoffPayload(owned.rows[0].payload_redacted);
      if (
        payload.refreshPending !== true ||
        payload.refreshGeneration !== prepared.refreshGeneration
      ) {
        throw new Error("STALE_DELIVERY_NOTIFICATION_REFRESH");
      }
      await fenceCapabilityAdoption(trx, nextRef);
      payload = removeOrphanRef(payload, nextRef);
      if (input.claim.capabilityRef !== nextRef) {
        payload = addOrphanRef(payload, input.claim.capabilityRef);
      }
      payload = { ...payload, refreshPending: false };
      const updated = await sql`
        update delivery_notification_handoff
        set capability_ref = ${nextRef}, capability_expires_at =
              ${new Date(prepared.session.claims.expiresAt * 1000).toISOString()},
            stored_at = now(), ready_at = now(),
            payload_redacted = ${JSON.stringify(payload)}::jsonb
        where id = ${input.claim.id} and status = 'PROCESSING'
          and claimed_by = ${input.claim.owner}
          and claim_generation = ${input.claim.generation}
          and capability_ref = ${input.claim.capabilityRef}
        returning id
      `.execute(trx);
      if (!updated.rows[0]) throw new Error("STALE_DELIVERY_NOTIFICATION_CLAIM");
      const activated = await sql`
        update delivery_session set activated_at = coalesce(activated_at, now())
        where id = ${prepared.session.claims.sessionId}
          and activated_at is null and revoked_at is null and used_at is null
        returning id
      `.execute(trx);
      if (!activated.rows[0]) throw new Error("DELIVERY_SESSION_ADOPTION_FAILED");
    });
  } catch (error) {
    const stillOwned = await sql<{ id: string }>`
      select id from delivery_notification_handoff
      where id = ${input.claim.id} and status = 'PROCESSING'
        and claimed_by = ${input.claim.owner}
        and claim_generation = ${input.claim.generation}
    `.execute(input.db);
    if (stillOwned.rows[0]) {
      try {
        await input.vault.delete(nextRef);
      } catch {
        await tombstoneOrphanCapability(input.db, input.claim.id, nextRef, {
          sessionId: prepared.session.claims.sessionId,
          reason: "REFRESH_SWAP_AND_DELETE_FAILED",
        });
      }
    } else {
      await tombstoneOrphanCapability(input.db, input.claim.id, nextRef, {
        sessionId: prepared.session.claims.sessionId,
        reason: "STALE_REFRESH_WRITE",
      });
    }
    throw error;
  }
  if (input.claim.capabilityRef !== nextRef) {
    try {
      await input.vault.delete(input.claim.capabilityRef);
      await clearOrphanCapability(input.db, input.claim.id, input.claim.capabilityRef);
    } catch {
      await tombstoneOrphanCapability(input.db, input.claim.id, input.claim.capabilityRef, {
        reason: "OLD_REFRESH_REF_DELETE_FAILED",
      });
    }
  }
  input.claim.capabilityRef = nextRef;
  return next;
}

export async function processDeliveryNotificationBatch(input: {
  db: Db;
  vault: Vault;
  sender: {
    send(input: {
      chatId: string;
      handoffId: string;
      idempotencyKey: string;
      signal: AbortSignal;
      product?: {
        name: string | null;
        usageInstructionsVi: string | null;
        warrantyVi: string | null;
      };
    }): Promise<void>;
  };
  owner: string;
  batchSize: number;
  maxAttempts: number;
  sessionConfig: DeliverySessionCodecConfig;
  sessionTtlSeconds: number;
  sendTimeoutMs?: number;
}): Promise<{ claimed: number; sent: number; failed: number; stale: number }> {
  if (
    !input.sessionConfig ||
    !Number.isInteger(input.sessionTtlSeconds) ||
    input.sessionTtlSeconds < 1 ||
    input.sessionTtlSeconds > 86_400
  ) {
    throw new Error("Delivery session configuration is required");
  }
  const sendTimeoutMs = input.sendTimeoutMs ?? DEFAULT_DELIVERY_NOTIFICATION_SEND_TIMEOUT_MS;
  if (
    !Number.isInteger(sendTimeoutMs) ||
    sendTimeoutMs < 1 ||
    sendTimeoutMs > MAX_DELIVERY_NOTIFICATION_SEND_TIMEOUT_MS
  ) {
    throw new Error("Invalid delivery notification send timeout");
  }
  const claims = await claimDeliveryNotifications(input.db, {
    owner: input.owner,
    batchSize: input.batchSize,
    leaseSeconds: DELIVERY_NOTIFICATION_LEASE_SECONDS,
  });
  let sent = 0;
  let failed = 0;
  let stale = 0;
  for (const claim of claims) {
    try {
      let capability = await loadDeliveryNotificationCapability(input.vault, claim);
      let sessionClaims = verifyDeliverySessionToken(capability.sessionToken, input.sessionConfig);
      const matchesClaim = () =>
        sessionClaims?.bundleId === claim.bundleId &&
        sessionClaims.customerId === claim.customerId &&
        sessionClaims.telegramUserId === claim.telegramChatId;
      if (!matchesClaim()) {
        capability = await refreshDeliveryNotificationCapability({
          db: input.db,
          vault: input.vault,
          claim,
          current: capability,
          sessionConfig: input.sessionConfig,
          sessionTtlSeconds: input.sessionTtlSeconds,
        });
        sessionClaims = verifyDeliverySessionToken(capability.sessionToken, input.sessionConfig);
        if (!matchesClaim()) throw new Error("Invalid refreshed delivery session capability");
      }
      const sendLease = await sql`
        update delivery_notification_handoff
        set claim_expires_at = now() +
          (${DELIVERY_NOTIFICATION_LEASE_SECONDS} * interval '1 second')
        where id = ${claim.id} and status = 'PROCESSING'
          and claimed_by = ${claim.owner} and claim_generation = ${claim.generation}
          and claim_expires_at > now()
          and bundle_id = ${claim.bundleId}
          and customer_id = ${claim.customerId}
          and telegram_chat_id = ${claim.telegramChatId}
          and capability_ref = ${claim.capabilityRef}
          and capability_expires_at > now()
        returning id
      `.execute(input.db);
      if (!sendLease.rows[0]) throw new Error("STALE_DELIVERY_NOTIFICATION_CLAIM");
      await sendDeliveryNotificationWithTimeout(
        input.sender,
        {
          chatId: claim.telegramChatId,
          handoffId: claim.id,
          idempotencyKey: claim.id,
          product: {
            name: claim.productName,
            usageInstructionsVi: claim.usageInstructionsVi,
            warrantyVi: claim.warrantyVi,
          },
        },
        sendTimeoutMs,
      );
      const result = await sql`
        update delivery_notification_handoff
        set status = 'SENT', sent_at = now(), claimed_by = null, claim_expires_at = null
        where id = ${claim.id} and status = 'PROCESSING'
          and claimed_by = ${claim.owner} and claim_generation = ${claim.generation}
          and claim_expires_at > now()
          and bundle_id = ${claim.bundleId}
          and customer_id = ${claim.customerId}
          and telegram_chat_id = ${claim.telegramChatId}
          and capability_ref = ${claim.capabilityRef}
          and capability_expires_at > now()
        returning id
      `.execute(input.db);
      if (result.rows[0]) sent += 1;
      else stale += 1;
    } catch (error) {
      const code = error instanceof Error ? error.name.slice(0, 128) : "UNKNOWN_ERROR";
      const terminal =
        claim.attemptCount >= input.maxAttempts ||
        AMBIGUOUS_DELIVERY_NOTIFICATION_SEND_ERRORS[code] === true;
      const result = await sql`
        update delivery_notification_handoff
        set status = ${terminal ? "DEAD" : "RETRY"},
            next_attempt_at = now(),
            last_error_code = ${code},
            claimed_by = null,
            claim_expires_at = null
        where id = ${claim.id} and status = 'PROCESSING'
          and claimed_by = ${claim.owner} and claim_generation = ${claim.generation}
          and claim_expires_at > now()
        returning id
      `.execute(input.db);
      if (result.rows[0]) failed += 1;
      else stale += 1;
    }
  }
  return { claimed: claims.length, sent, failed, stale };
}

const SAFE_TELEGRAM_DELIVERY_OPEN_ERROR =
  "Không mở được thông tin nhận hàng. Thử lại hoặc liên hệ hỗ trợ.";

function deliveryTokenFromUrl(deliveryUrl: string): string | null {
  try {
    const parsed = new URL(deliveryUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const marker = parts.lastIndexOf("d");
    const token = marker >= 0 ? parts[marker + 1] : parts.at(-1);
    return token && token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

export async function openTelegramDeliveryHandoff(input: {
  db: Db;
  vault: Vault;
  sessionConfig: DeliverySessionCodecConfig;
  telegramUserId: string;
  handoffId: string;
  correlationId: string;
}): Promise<
  | {
      ok: true;
      secret: string;
      productName: string | null;
      usageInstructionsVi: string | null;
      warrantyVi: string | null;
    }
  | { ok: false; message: string }
> {
  if (!isId(input.handoffId)) return { ok: false, message: SAFE_TELEGRAM_DELIVERY_OPEN_ERROR };
  const row = await sql<{
    id: string;
    bundle_id: string;
    customer_id: string;
    telegram_chat_id: string;
    capability_ref: string;
    product_name: string | null;
    usage_instructions_vi: string | null;
    warranty_vi: string | null;
  }>`
    select h.id, h.bundle_id, h.customer_id, h.telegram_chat_id, h.capability_ref,
      o.product_name_vi as product_name,
      p.usage_instructions_vi, p.warranty_vi
    from delivery_notification_handoff h
    join delivery_bundle b on b.id = h.bundle_id
    left join "order" o on o.id = b.order_id
    left join product_variant v on v.id = o.variant_id
    left join product p on p.id = v.product_id
    where h.id = ${input.handoffId}
      and h.telegram_chat_id = ${input.telegramUserId}
      and h.capability_ref is not null
    limit 1
  `.execute(input.db);
  const handoff = row.rows[0];
  if (!handoff) return { ok: false, message: SAFE_TELEGRAM_DELIVERY_OPEN_ERROR };

  let capability: DeliveryNotificationCapability;
  try {
    capability = await loadDeliveryNotificationCapability(input.vault, {
      id: handoff.id,
      bundleId: handoff.bundle_id,
      customerId: handoff.customer_id,
      telegramChatId: handoff.telegram_chat_id,
      capabilityRef: handoff.capability_ref,
      owner: "telegram-open",
      generation: 0,
      attemptCount: 0,
      productName: handoff.product_name,
      usageInstructionsVi: handoff.usage_instructions_vi,
      warrantyVi: handoff.warranty_vi,
    });
  } catch {
    return { ok: false, message: SAFE_TELEGRAM_DELIVERY_OPEN_ERROR };
  }

  const session = verifyDeliverySessionToken(capability.sessionToken, input.sessionConfig);
  const token = deliveryTokenFromUrl(capability.deliveryUrl);
  if (
    session == null ||
    token == null ||
    session.bundleId !== handoff.bundle_id ||
    session.customerId !== handoff.customer_id ||
    session.telegramUserId !== input.telegramUserId
  ) {
    return { ok: false, message: SAFE_TELEGRAM_DELIVERY_OPEN_ERROR };
  }

  const revealed = await revealDeliveryBundle(input.db, {
    token,
    session,
    correlationId: input.correlationId,
    vault: input.vault,
  });
  if (!revealed.ok) return { ok: false, message: SAFE_TELEGRAM_DELIVERY_OPEN_ERROR };
  return {
    ok: true,
    secret: revealed.secret,
    productName: handoff.product_name,
    usageInstructionsVi: handoff.usage_instructions_vi,
    warrantyVi: handoff.warranty_vi,
  };
}
