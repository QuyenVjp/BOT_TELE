import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { isId, newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { getStoreModeForUpdate } from "../commerce/store-mode.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const LEASE_SECONDS = 300;

export type FileDeliveryStatus = "QUEUED" | "PROCESSING" | "SENT" | "FAILED";

export interface FileDeliveryJob {
  orderId: string;
  customerId: string;
  variantId: string;
  artifactId: string;
  artifactVersion: number;
  artifactSha256: string;
  telegramChatId: string;
  status: FileDeliveryStatus;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  attemptCount: number;
  claimGeneration: number;
  lastError: string | null;
}
export type FileDeliveryRecoveryDecision = "KEEP_UNCERTAIN" | "REQUEUE";

export interface ResolveUncertainFileDeliveryInput {
  db: Db;
  orderId: string;
  /** The job is keyed by order_id in the existing schema. */
  jobId?: string;
  expectedOrderVersion: number;
  expectedClaimGeneration?: number;
  artifactId: string;
  artifactVersion: number;
  artifactSha256: string;
  telegramChatId: string;
  operatorId: string;
  reason: string;
  decision?: FileDeliveryRecoveryDecision;
  correlationId?: string;
}

export type ResolveUncertainFileDeliveryInTransactionInput = Omit<
  ResolveUncertainFileDeliveryInput,
  "db"
>;

export type ResolveUncertainFileDeliveryResult =
  | {
      ok: true;
      decision: FileDeliveryRecoveryDecision;
      requeued: boolean;
      alreadyApplied: boolean;
      auditEventId: string;
      job: FileDeliveryJob;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "JOB_NOT_FOUND"
        | "STALE_ORDER"
        | "STALE_JOB"
        | "NOT_UNCERTAIN"
        | "STORE_MODE_POLICY";
    };

export const FILE_DELIVERY_SENT_AUDIT_ACTION = "file_delivery.sent";
export const FILE_DELIVERY_UNCERTAIN_AUDIT_ACTION = "file_delivery.uncertain";
export const FILE_DELIVERY_RECOVERY_AUDIT_ACTION = "file_delivery.recovery";

export interface QueueFileDeliveryInput {
  db: Db;
  orderId: string;
  createIfMissing?: boolean;
}

export interface ProcessFileDeliveryInput {
  db: Db;
  job: FileDeliveryJob;
  storageRoots: readonly string[];
  sender: TelegramDocumentSender;
}

export interface TelegramDocumentSender {
  sendDocument(input: {
    chatId: string;
    filename: string;
    mimeType: string;
    caption: string;
    source: { kind: "bytes"; bytes: Uint8Array } | { kind: "telegram_file_id"; fileId: string };
  }): Promise<{ fileId: string; fileUniqueId: string | null; messageId?: string | null }>;
}

export type QueueFileDeliveryResult =
  | { ok: true; job: FileDeliveryJob; inserted: boolean }
  | {
      ok: false;
      code:
        | "ORDER_NOT_FOUND"
        | "ORDER_NOT_PAID"
        | "NOT_DIGITAL_FILE"
        | "NO_TELEGRAM_CHAT"
        | "NO_ACTIVE_ARTIFACT"
        | "JOB_NOT_FOUND";
    };
export type ProcessFileDeliveryResult =
  | { ok: true; job: FileDeliveryJob; reusedTelegramFileId: boolean }
  | {
      ok: false;
      code:
        | "JOB_NOT_FOUND"
        | "STALE_JOB"
        | "ORDER_NOT_PAID"
        | "INVALID_STORAGE_REFERENCE"
        | "FILE_HASH_MISMATCH"
        | "FILE_SIZE_MISMATCH"
        | "SEND_UNCERTAIN"
        | "SEND_FAILED";
    };

type JobRow = {
  order_id: string;
  customer_id: string;
  variant_id: string;
  artifact_id: string;
  artifact_version: number;
  artifact_sha256: string;
  telegram_chat_id: string;
  status: FileDeliveryStatus;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  attempt_count: number;
  claim_generation: number;
  processing_expires_at: Date | string | null;
  last_error: string | null;
};

type ArtifactRow = {
  artifact_id: string;
  artifact_variant_id: string;
  artifact_version: number;
  filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_reference: string;
  artifact_telegram_file_id: string | null;
};

function mapJob(row: JobRow): FileDeliveryJob {
  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    variantId: row.variant_id,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    artifactSha256: row.artifact_sha256,
    telegramChatId: row.telegram_chat_id,
    status: row.status,
    telegramFileId: row.telegram_file_id,
    telegramFileUniqueId: row.telegram_file_unique_id,
    attemptCount: row.attempt_count,
    claimGeneration: row.claim_generation,
    lastError: row.last_error,
  };
}

function isInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`)
  );
}

async function resolvePrivatePath(
  storageReference: string,
  storageRoots: readonly string[],
): Promise<string | null> {
  if (storageReference.startsWith("file://")) {
    try {
      const url = new URL(storageReference);
      if (url.host) return null;
      storageReference = fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (storageReference.includes("\0") || !storageReference.startsWith("/")) return null;
  const [resolvedPath, resolvedRoots] = await Promise.all([
    realpath(storageReference).catch(() => null),
    Promise.all(storageRoots.map((root) => realpath(root).catch(() => null))),
  ]);
  if (!resolvedPath) return null;
  return resolvedRoots.some((root) => root !== null && isInsideRoot(resolvedPath, root))
    ? resolvedPath
    : null;
}

async function verifiedFileBytes(
  path: string,
  artifact: ArtifactRow,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; code: "FILE_HASH_MISMATCH" | "FILE_SIZE_MISMATCH" }
> {
  const expectedSize = BigInt(artifact.size_bytes);
  if (expectedSize > BigInt(MAX_FILE_BYTES)) return { ok: false, code: "FILE_SIZE_MISMATCH" };
  const expectedBytes = Number(expectedSize);
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || BigInt(stat.size) !== expectedSize)
      return { ok: false, code: "FILE_SIZE_MISMATCH" };
    const buffer = Buffer.allocUnsafe(expectedBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, expectedBytes + 1, 0);
    if (bytesRead !== expectedBytes) return { ok: false, code: "FILE_SIZE_MISMATCH" };
    const bytes = buffer.subarray(0, bytesRead);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return hash === artifact.sha256
      ? { ok: true, bytes }
      : { ok: false, code: "FILE_HASH_MISMATCH" };
  } finally {
    await file.close();
  }
}

async function readJob(exec: Executor, orderId: string): Promise<FileDeliveryJob | null> {
  const result = await sql<JobRow>`
    select order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
           telegram_chat_id, status, telegram_file_id, telegram_file_unique_id, attempt_count,
           claim_generation, processing_expires_at, last_error
    from file_delivery_job
    where order_id = ${orderId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapJob(row) : null;
}
function validRecoveryInput(
  input: ResolveUncertainFileDeliveryInTransactionInput,
  decision: FileDeliveryRecoveryDecision,
): boolean {
  return (
    typeof input.orderId === "string" &&
    isId(input.orderId) &&
    (input.jobId === undefined ||
      (typeof input.jobId === "string" && input.jobId === input.orderId)) &&
    Number.isInteger(input.expectedOrderVersion) &&
    input.expectedOrderVersion >= 1 &&
    (input.expectedClaimGeneration === undefined ||
      (Number.isInteger(input.expectedClaimGeneration) && input.expectedClaimGeneration >= 0)) &&
    typeof input.artifactId === "string" &&
    isId(input.artifactId) &&
    Number.isInteger(input.artifactVersion) &&
    input.artifactVersion > 0 &&
    typeof input.artifactSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(input.artifactSha256) &&
    typeof input.telegramChatId === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(input.telegramChatId) &&
    typeof input.operatorId === "string" &&
    input.operatorId.trim().length > 0 &&
    input.operatorId.length <= 128 &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0 &&
    input.reason.length <= 500 &&
    (input.correlationId === undefined ||
      (typeof input.correlationId === "string" &&
        input.correlationId.trim().length > 0 &&
        input.correlationId.length <= 128)) &&
    (decision === "KEEP_UNCERTAIN" || decision === "REQUEUE")
  );
}

function recoveryCorrelation(
  input: ResolveUncertainFileDeliveryInTransactionInput,
  decision: FileDeliveryRecoveryDecision,
  generation: number,
): string {
  return (
    input.correlationId?.trim() ??
    `file-delivery-recovery:${input.orderId}:${input.expectedOrderVersion}:${generation}:${decision}`
  );
}

export async function resolveUncertainFileDeliveryInTransaction(
  exec: Executor,
  input: ResolveUncertainFileDeliveryInTransactionInput,
): Promise<ResolveUncertainFileDeliveryResult> {
  const decision = input.decision ?? "KEEP_UNCERTAIN";
  if (!validRecoveryInput(input, decision)) return { ok: false, code: "INVALID_INPUT" };

  const order = await findOrderByIdForUpdate(exec, input.orderId);
  if (!order) return { ok: false, code: "JOB_NOT_FOUND" };
  if (order.version !== input.expectedOrderVersion) return { ok: false, code: "STALE_ORDER" };
  if (order.status !== "PAID" && order.status !== "PROCESSING")
    return { ok: false, code: "STALE_ORDER" };

  const result = await sql<JobRow>`
    select *
    from file_delivery_job
    where order_id = ${input.orderId}
    limit 1
    for update
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return { ok: false, code: "JOB_NOT_FOUND" };
  if (
    (input.jobId !== undefined && row.order_id !== input.jobId) ||
    row.telegram_chat_id !== input.telegramChatId
  )
    return { ok: false, code: "STALE_JOB" };
  if (
    input.expectedClaimGeneration !== undefined &&
    row.claim_generation !== input.expectedClaimGeneration
  )
    return { ok: false, code: "STALE_JOB" };
  if (
    row.artifact_id !== input.artifactId ||
    row.artifact_version !== input.artifactVersion ||
    row.artifact_sha256 !== input.artifactSha256
  )
    return { ok: false, code: "STALE_JOB" };
  const correlationId = recoveryCorrelation(input, decision, row.claim_generation);
  const prior = await sql<{ id: string; decision: string | null }>`
    select id, metadata_redacted->>'decision' as decision
    from audit_event
    where action = ${FILE_DELIVERY_RECOVERY_AUDIT_ACTION}
      and target_type = 'FileDeliveryJob'
      and target_id = ${row.order_id}
      and correlation_id = ${correlationId}
    order by occurred_at desc, id desc
    limit 1
  `.execute(exec);
  if (
    prior.rows[0]?.decision === decision &&
    ((decision === "KEEP_UNCERTAIN" &&
      row.status === "FAILED" &&
      row.last_error === "SEND_UNCERTAIN") ||
      (decision === "REQUEUE" && row.status === "QUEUED"))
  ) {
    return {
      ok: true,
      decision,
      requeued: decision === "REQUEUE",
      alreadyApplied: true,
      auditEventId: prior.rows[0].id,
      job: mapJob(row),
    };
  }
  if (row.status !== "FAILED" || row.last_error !== "SEND_UNCERTAIN")
    return { ok: false, code: "NOT_UNCERTAIN" };

  if (decision === "REQUEUE") {
    const mode = await getStoreModeForUpdate(exec);
    if (mode !== "OPEN") {
      const policy = await sql<{ is_test: boolean; customer_allowed: boolean }>`
        select
          exists (
            select 1
            from product_variant v
            join product p on p.id = v.product_id
            where v.id = ${row.variant_id} and p.is_test
          ) as is_test,
          ${row.telegram_chat_id} = ${input.operatorId.trim()}
          or exists (
            select 1
            from test_customer_allowlist a
            where a.telegram_user_id::text = ${row.telegram_chat_id}::text
          ) as customer_allowed
      `.execute(exec);
      if (!policy.rows[0]?.is_test || !policy.rows[0].customer_allowed) {
        return { ok: false, code: "STORE_MODE_POLICY" };
      }
    }
  }

  let effective = row;
  if (decision === "REQUEUE") {
    const updated = await sql<JobRow>`
      update file_delivery_job
      set status = 'QUEUED', processing_expires_at = null, last_error = null, updated_at = now()
      where order_id = ${row.order_id}
        and status = 'FAILED'
        and last_error = 'SEND_UNCERTAIN'
        and claim_generation = ${row.claim_generation}
      returning *
    `.execute(exec);
    effective = updated.rows[0] ?? row;
    if (!updated.rows[0]) return { ok: false, code: "STALE_JOB" };
  }
  if (decision === "REQUEUE") {
    await enqueueOutboxEvent(exec, {
      id: newId(),
      aggregateType: "FileDeliveryJob",
      aggregateId: row.order_id,
      aggregateVersion: row.claim_generation + 1,
      eventType: "FileDeliveryRetryRequested",
      payloadRedacted: {
        orderId: row.order_id,
        jobId: row.order_id,
        artifactId: row.artifact_id,
        artifactVersion: row.artifact_version,
        artifactSha256: row.artifact_sha256,
        claimGeneration: row.claim_generation,
        telegramChatId: row.telegram_chat_id,
        correlationId,
      },
    });
  }

  const auditEventId = await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.operatorId.trim(),
    action: FILE_DELIVERY_RECOVERY_AUDIT_ACTION,
    targetType: "FileDeliveryJob",
    targetId: row.order_id,
    reason: input.reason,
    correlationId,
    metadataRedacted: {
      decision,
      orderId: row.order_id,
      jobId: row.order_id,
      customerId: row.customer_id,
      variantId: row.variant_id,
      artifactId: row.artifact_id,
      artifactVersion: row.artifact_version,
      artifactSha256: row.artifact_sha256,
      expectedOrderVersion: input.expectedOrderVersion,
      orderVersion: order.version,
      claimGeneration: row.claim_generation,
      previousStatus: row.status,
      previousError: row.last_error,
      status: effective.status,
      uncertainty: "UNKNOWN",
    },
  });
  return {
    ok: true,
    decision,
    requeued: decision === "REQUEUE",
    alreadyApplied: false,
    auditEventId,
    job: mapJob(effective),
  };
}

export async function resolveUncertainFileDelivery(
  input: ResolveUncertainFileDeliveryInput,
): Promise<ResolveUncertainFileDeliveryResult> {
  return withTransaction(input.db, (trx) => resolveUncertainFileDeliveryInTransaction(trx, input));
}

function isProvenTelegramSendFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GrammyError") return false;
  if (!("error_code" in error)) return false;
  const code = error.error_code;
  return typeof code === "number" && code >= 400 && code < 500 && code !== 429;
}

async function appendUncertainAudit(exec: Executor, row: JobRow): Promise<void> {
  await appendAuditEvent(exec, {
    actorType: "SYSTEM",
    actorId: "file-delivery",
    action: FILE_DELIVERY_UNCERTAIN_AUDIT_ACTION,
    targetType: "FileDeliveryJob",
    targetId: row.order_id,
    reason: "Telegram document send outcome is unknown",
    correlationId: `file-delivery:${row.order_id}:${row.claim_generation}:uncertain`,
    metadataRedacted: {
      status: "FAILED",
      outcome: "UNKNOWN",
      orderId: row.order_id,
      jobId: row.order_id,
      customerId: row.customer_id,
      variantId: row.variant_id,
      artifactId: row.artifact_id,
      artifactVersion: row.artifact_version,
      artifactSha256: row.artifact_sha256,
      claimGeneration: row.claim_generation,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
    },
  });
}

async function markProcessingFailed(
  db: Db,
  orderId: string,
  generation: number,
  code: string,
): Promise<void> {
  await withTransaction(db, async (trx) => {
    const updated = await sql<JobRow>`
      update file_delivery_job
      set status = 'FAILED', last_error = ${code}, processing_expires_at = null, updated_at = now()
      where order_id = ${orderId} and status = 'PROCESSING' and claim_generation = ${generation}
      returning *
    `.execute(trx);
    const row = updated.rows[0];
    if (!row || code !== "SEND_UNCERTAIN") return;
    await appendUncertainAudit(trx, row);
  });
}

export async function queueFileDelivery(
  input: QueueFileDeliveryInput,
): Promise<QueueFileDeliveryResult> {
  return withTransaction(input.db, async (trx) => {
    const order = await sql<{
      order_id: string;
      customer_id: string;
      variant_id: string;
      status: string;
      fulfillment_type: string;
      telegram_chat_id: string | null;
    }>`
      select o.id as order_id, o.customer_id, o.variant_id, o.status, o.fulfillment_type,
             coalesce(cps.chat_id, ci.channel_user_id) as telegram_chat_id
      from "order" o
      left join customer_profile_snapshot cps on cps.customer_id = o.customer_id and cps.reachable
      left join channel_identity ci on ci.customer_id = o.customer_id and ci.channel = 'TELEGRAM'
      where o.id = ${input.orderId}
      limit 1
      for update of o
    `.execute(trx);
    const row = order.rows[0];
    if (!row) return { ok: false, code: "ORDER_NOT_FOUND" };
    const existing = await readJob(trx, input.orderId);
    if (existing) return { ok: true, job: existing, inserted: false };
    if (input.createIfMissing === false) return { ok: false, code: "JOB_NOT_FOUND" };
    if (row.status !== "PAID" && row.status !== "PROCESSING")
      return { ok: false, code: "ORDER_NOT_PAID" };
    if (row.fulfillment_type !== "DIGITAL_FILE") return { ok: false, code: "NOT_DIGITAL_FILE" };
    if (!row.telegram_chat_id) return { ok: false, code: "NO_TELEGRAM_CHAT" };

    const artifact = await sql<{ id: string; version: number; sha256: string }>`
      select id, version, sha256
      from variant_file_artifact
      where variant_id = ${row.variant_id} and is_active
      order by version desc, created_at desc, id desc
      limit 1
    `.execute(trx);
    const selected = artifact.rows[0];
    if (!selected) return { ok: false, code: "NO_ACTIVE_ARTIFACT" };

    const inserted = await sql<JobRow>`
      insert into file_delivery_job
        (order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256, telegram_chat_id)
      values
        (${row.order_id}, ${row.customer_id}, ${row.variant_id}, ${selected.id}, ${selected.version}, ${selected.sha256}, ${row.telegram_chat_id})
      returning order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
                telegram_chat_id, status, telegram_file_id, telegram_file_unique_id, attempt_count,
                claim_generation, processing_expires_at, last_error
    `.execute(trx);
    return { ok: true, job: mapJob(inserted.rows[0]!), inserted: true };
  });
}

export async function processFileDelivery(
  input: ProcessFileDeliveryInput,
): Promise<ProcessFileDeliveryResult> {
  const claimed = await withTransaction(input.db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, input.job.orderId);
    const job = await sql<JobRow & ArtifactRow>`
      select j.order_id, j.customer_id, j.variant_id, j.artifact_id, j.artifact_version, j.artifact_sha256,
             j.telegram_chat_id, j.status, j.telegram_file_id, j.telegram_file_unique_id, j.attempt_count,
             j.claim_generation, j.processing_expires_at, j.last_error,
             a.id as artifact_id, a.variant_id as artifact_variant_id, a.version as artifact_version, a.filename, a.mime_type,
             a.size_bytes::text as size_bytes, a.sha256, a.storage_reference, a.telegram_file_id as artifact_telegram_file_id
      from file_delivery_job j
      join variant_file_artifact a on a.id = j.artifact_id
      where j.order_id = ${input.job.orderId}
      limit 1 for update of j
    `.execute(trx);
    const current = job.rows[0];
    if (!current) return null;
    if (
      current.customer_id !== input.job.customerId ||
      current.variant_id !== input.job.variantId ||
      current.artifact_id !== input.job.artifactId ||
      current.artifact_version !== input.job.artifactVersion ||
      current.artifact_sha256 !== input.job.artifactSha256
    )
      return "STALE_JOB" as const;
    if (current.status === "SENT") {
      return order?.status === "COMPLETED"
        ? {
            row: current,
            generation: current.claim_generation,
            attemptCount: current.attempt_count,
          }
        : ("ORDER_NOT_PAID" as const);
    }
    if (current.status === "FAILED" && current.last_error === "SEND_UNCERTAIN") {
      return "SEND_UNCERTAIN" as const;
    }
    const leaseExpiresAt = current.processing_expires_at
      ? new Date(current.processing_expires_at).getTime()
      : 0;
    // An expired lease cannot distinguish pre-send work from a remotely accepted send.
    // Park it instead of reclaiming it for another Telegram call.
    if (current.status === "PROCESSING") {
      if (leaseExpiresAt > Date.now()) return "STALE_JOB" as const;
      const updated = await sql<JobRow>`
        update file_delivery_job
        set status = 'FAILED', last_error = 'SEND_UNCERTAIN', processing_expires_at = null, updated_at = now()
        where order_id = ${input.job.orderId}
          and status = 'PROCESSING'
          and claim_generation = ${current.claim_generation}
        returning *
      `.execute(trx);
      if (updated.rows[0]) await appendUncertainAudit(trx, updated.rows[0]);
      return "SEND_UNCERTAIN" as const;
    }
    if (!order || (order.status !== "PAID" && order.status !== "PROCESSING"))
      return "ORDER_NOT_PAID" as const;
    const nextGeneration = current.claim_generation + 1;
    const nextAttemptCount = current.attempt_count + 1;
    await sql`
      update file_delivery_job
      set status = 'PROCESSING', claim_generation = ${nextGeneration}, attempt_count = ${nextAttemptCount},
          processing_expires_at = now() + (${LEASE_SECONDS} || ' seconds')::interval, last_error = null, updated_at = now()
      where order_id = ${input.job.orderId}
        and claim_generation = ${current.claim_generation}
        and status = ${current.status}
    `.execute(trx);
    return { row: current, generation: nextGeneration, attemptCount: nextAttemptCount };
  });

  if (claimed === null) return { ok: false, code: "JOB_NOT_FOUND" };
  if (claimed === "STALE_JOB") return { ok: false, code: "STALE_JOB" };
  if (claimed === "ORDER_NOT_PAID") return { ok: false, code: "ORDER_NOT_PAID" };
  if (claimed === "SEND_UNCERTAIN") return { ok: false, code: "SEND_UNCERTAIN" };
  if (claimed.row.status === "SENT")
    return {
      ok: true,
      job: mapJob(claimed.row),
      reusedTelegramFileId: Boolean(claimed.row.telegram_file_id),
    };

  const artifact: ArtifactRow = claimed.row;
  const cachedFileId = artifact.artifact_telegram_file_id;
  let source: { kind: "telegram_file_id"; fileId: string } | { kind: "bytes"; bytes: Uint8Array };
  if (cachedFileId) {
    source = { kind: "telegram_file_id", fileId: cachedFileId };
  } else {
    const path = await resolvePrivatePath(artifact.storage_reference, input.storageRoots);
    if (!path) {
      await markProcessingFailed(
        input.db,
        input.job.orderId,
        claimed.generation,
        "INVALID_STORAGE_REFERENCE",
      );
      return { ok: false, code: "INVALID_STORAGE_REFERENCE" };
    }
    const verified = await verifiedFileBytes(path, artifact);
    if (!verified.ok) {
      await markProcessingFailed(input.db, input.job.orderId, claimed.generation, verified.code);
      return { ok: false, code: verified.code };
    }
    source = { kind: "bytes", bytes: verified.bytes };
  }

  const sendReady = await withTransaction(input.db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, claimed.row.order_id);
    const job = await sql<{
      artifact_id: string;
      artifact_version: number;
      artifact_sha256: string;
      status: FileDeliveryStatus;
      claim_generation: number;
      processing_expires_at: Date | string | null;
    }>`
      select j.artifact_id, j.artifact_version, j.artifact_sha256,
             j.status, j.claim_generation, j.processing_expires_at
      from file_delivery_job j
      where j.order_id = ${claimed.row.order_id}
      limit 1
      for update of j
    `.execute(trx);
    const current = job.rows[0];
    if (!current) return "JOB_NOT_FOUND" as const;
    if (
      current.status !== "PROCESSING" ||
      current.claim_generation !== claimed.generation ||
      current.artifact_id !== claimed.row.artifact_id ||
      current.artifact_version !== claimed.row.artifact_version ||
      current.artifact_sha256 !== claimed.row.artifact_sha256
    )
      return "STALE_JOB" as const;
    const leaseExpiresAt = current.processing_expires_at
      ? new Date(current.processing_expires_at).getTime()
      : 0;
    if (leaseExpiresAt <= Date.now()) {
      const updated = await sql<JobRow>`
        update file_delivery_job
        set status = 'FAILED', last_error = 'SEND_UNCERTAIN', processing_expires_at = null, updated_at = now()
        where order_id = ${claimed.row.order_id}
          and status = 'PROCESSING'
          and claim_generation = ${claimed.generation}
        returning *
      `.execute(trx);
      if (updated.rows[0]) await appendUncertainAudit(trx, updated.rows[0]);
      return "SEND_UNCERTAIN" as const;
    }
    if (!order || (order.status !== "PAID" && order.status !== "PROCESSING")) {
      await sql`
        update file_delivery_job
        set status = 'FAILED', last_error = 'ORDER_NOT_PAID', processing_expires_at = null, updated_at = now()
        where order_id = ${claimed.row.order_id}
          and status = 'PROCESSING'
          and claim_generation = ${claimed.generation}
      `.execute(trx);
      return "ORDER_NOT_PAID" as const;
    }
    if (order.status === "PAID") {
      await transitionOrder(trx, order, "PROCESSING", "FILE_DELIVERY_STARTED", "file-delivery", {
        type: "SYSTEM",
        id: "file-delivery",
      });
    }
    return "READY" as const;
  });
  if (sendReady === "JOB_NOT_FOUND") return { ok: false, code: "JOB_NOT_FOUND" };
  if (sendReady === "STALE_JOB") return { ok: false, code: "STALE_JOB" };
  if (sendReady === "ORDER_NOT_PAID") return { ok: false, code: "ORDER_NOT_PAID" };
  if (sendReady === "SEND_UNCERTAIN") return { ok: false, code: "SEND_UNCERTAIN" };

  let sent: { fileId: string; fileUniqueId: string | null; messageId?: string | null };
  try {
    sent = await input.sender.sendDocument({
      chatId: claimed.row.telegram_chat_id,
      filename: artifact.filename,
      mimeType: artifact.mime_type,
      caption: "Tệp số cho đơn hàng của bạn.",
      source,
    });
  } catch (error) {
    const code = isProvenTelegramSendFailure(error) ? "SEND_FAILED" : "SEND_UNCERTAIN";
    await markProcessingFailed(input.db, input.job.orderId, claimed.generation, code);
    return { ok: false, code };
  }

  const finalized = await withTransaction(input.db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, claimed.row.order_id);
    if (!order) return "ORDER_NOT_PAID" as const;
    if (
      order.id !== claimed.row.order_id ||
      order.customerId !== claimed.row.customer_id ||
      order.variantId !== claimed.row.variant_id
    )
      return "STALE_JOB" as const;
    const fenced = await sql<JobRow>`
      update file_delivery_job
      set status = 'SENT', telegram_file_id = ${sent.fileId}, telegram_file_unique_id = ${sent.fileUniqueId},
          sent_at = now(), processing_expires_at = null, last_error = null, updated_at = now()
      where order_id = ${claimed.row.order_id}
        and customer_id = ${claimed.row.customer_id}
        and variant_id = ${claimed.row.variant_id}
        and telegram_chat_id = ${claimed.row.telegram_chat_id}
        and attempt_count = ${claimed.attemptCount}
        and (
          status = 'PROCESSING'
          or (status = 'FAILED' and last_error = 'SEND_UNCERTAIN')
        )
        and claim_generation = ${claimed.generation}
        and artifact_id = ${claimed.row.artifact_id}
        and artifact_version = ${claimed.row.artifact_version}
        and artifact_sha256 = ${claimed.row.artifact_sha256}
        and exists (
          select 1
          from variant_file_artifact a
          where a.id = ${claimed.row.artifact_id}
            and a.variant_id = ${claimed.row.artifact_variant_id}
            and a.version = ${claimed.row.artifact_version}
            and a.sha256 = ${claimed.row.artifact_sha256}
        )
      returning order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
                telegram_chat_id, status, telegram_file_id, telegram_file_unique_id, attempt_count,
                claim_generation, processing_expires_at, last_error
    `.execute(trx);
    const sentJob = fenced.rows[0];
    if (!sentJob) return "STALE_JOB" as const;
    await sql`
      update variant_file_artifact
      set telegram_file_id = coalesce(telegram_file_id, ${sent.fileId}),
          telegram_file_unique_id = coalesce(telegram_file_unique_id, ${sent.fileUniqueId})
      where id = ${claimed.row.artifact_id}
        and variant_id = ${claimed.row.artifact_variant_id}
        and version = ${claimed.row.artifact_version}
        and sha256 = ${claimed.row.artifact_sha256}
    `.execute(trx);
    if (order.status === "PAID") {
      const processing = await transitionOrder(
        trx,
        order,
        "PROCESSING",
        "FILE_DELIVERY_STARTED",
        "file-delivery",
        { type: "SYSTEM", id: "file-delivery" },
      );
      await transitionOrder(trx, processing, "COMPLETED", "FILE_DELIVERY_SENT", "file-delivery", {
        type: "SYSTEM",
        id: "file-delivery",
      });
    } else if (order.status === "PROCESSING") {
      await transitionOrder(trx, order, "COMPLETED", "FILE_DELIVERY_SENT", "file-delivery", {
        type: "SYSTEM",
        id: "file-delivery",
      });
    }
    await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      actorId: "file-delivery",
      action: FILE_DELIVERY_SENT_AUDIT_ACTION,
      targetType: "FileDeliveryJob",
      targetId: sentJob.order_id,
      reason: "Telegram document send succeeded",
      correlationId: `file-delivery:${sentJob.order_id}:${sentJob.claim_generation}`,
      metadataRedacted: {
        status: "SENT",
        orderId: sentJob.order_id,
        jobId: sentJob.order_id,
        customerId: sentJob.customer_id,
        variantId: sentJob.variant_id,
        artifactId: sentJob.artifact_id,
        artifactVersion: sentJob.artifact_version,
        artifactSha256: sentJob.artifact_sha256,
        attemptCount: sentJob.attempt_count,
        telegramMessageId: sent.messageId ?? null,
        telegramFileUniqueId: sent.fileUniqueId,
      },
    });
    return mapJob(sentJob);
  });
  if (finalized === "STALE_JOB") return { ok: false, code: "STALE_JOB" };
  if (finalized === "ORDER_NOT_PAID") return { ok: false, code: "ORDER_NOT_PAID" };
  if (!finalized) return { ok: false, code: "STALE_JOB" };
  return { ok: true, job: finalized, reusedTelegramFileId: source.kind === "telegram_file_id" };
}
