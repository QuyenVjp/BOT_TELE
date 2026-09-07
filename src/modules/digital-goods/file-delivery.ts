import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";

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
}

export interface QueueFileDeliveryInput {
  db: Db;
  orderId: string;
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
  }): Promise<{ fileId: string; fileUniqueId: string | null }>;
}

export type QueueFileDeliveryResult =
  | { ok: true; job: FileDeliveryJob; inserted: boolean }
  | {
      ok: false;
      code:
        | "ORDER_NOT_FOUND"
        | "ORDER_NOT_PAID"
        | "NOT_DIGITAL_FILE"
        | "NO_ACTIVE_ARTIFACT"
        | "NO_TELEGRAM_CHAT";
    };

export type ProcessFileDeliveryResult =
  | { ok: true; job: FileDeliveryJob; reusedTelegramFileId: boolean }
  | {
      ok: false;
      code:
        | "JOB_NOT_FOUND"
        | "STALE_JOB"
        | "INVALID_STORAGE_REFERENCE"
        | "FILE_HASH_MISMATCH"
        | "FILE_SIZE_MISMATCH"
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
           claim_generation, processing_expires_at
    from file_delivery_job
    where order_id = ${orderId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row ? mapJob(row) : null;
}

async function markProcessingFailed(
  db: Db,
  orderId: string,
  generation: number,
  code: string,
): Promise<void> {
  await sql`
    update file_delivery_job
    set status = 'FAILED', last_error = ${code}, processing_expires_at = null, updated_at = now()
    where order_id = ${orderId} and status = 'PROCESSING' and claim_generation = ${generation}
  `.execute(db);
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
                claim_generation, processing_expires_at
    `.execute(trx);
    return { ok: true, job: mapJob(inserted.rows[0]!), inserted: true };
  });
}

export async function processFileDelivery(
  input: ProcessFileDeliveryInput,
): Promise<ProcessFileDeliveryResult> {
  const claimed = await withTransaction(input.db, async (trx) => {
    await findOrderByIdForUpdate(trx, input.job.orderId);
    const job = await sql<JobRow & ArtifactRow>`
      select j.order_id, j.customer_id, j.variant_id, j.artifact_id, j.artifact_version, j.artifact_sha256,
             j.telegram_chat_id, j.status, j.telegram_file_id, j.telegram_file_unique_id, j.attempt_count,
             j.claim_generation, j.processing_expires_at,
             a.id as artifact_id, a.variant_id as artifact_variant_id, a.version as artifact_version, a.filename, a.mime_type,
             a.size_bytes::text as size_bytes, a.sha256, a.storage_reference, a.telegram_file_id as artifact_telegram_file_id
      from file_delivery_job j
      join variant_file_artifact a on a.id = j.artifact_id
      where j.order_id = ${input.job.orderId}
      limit 1 for update of j
    `.execute(trx);
    const current = job.rows[0];
    if (!current) return null;
    if (current.status === "SENT") return { row: current, generation: current.claim_generation };
    if (
      current.artifact_id !== input.job.artifactId ||
      current.artifact_version !== input.job.artifactVersion ||
      current.artifact_sha256 !== input.job.artifactSha256
    )
      return "STALE_JOB" as const;
    const leaseExpiresAt = current.processing_expires_at
      ? new Date(current.processing_expires_at).getTime()
      : 0;
    if (current.status === "PROCESSING" && leaseExpiresAt > Date.now()) return "STALE_JOB" as const;
    const nextGeneration = current.claim_generation + 1;
    await sql`
      update file_delivery_job
      set status = 'PROCESSING', claim_generation = ${nextGeneration}, attempt_count = attempt_count + 1,
          processing_expires_at = now() + (${LEASE_SECONDS} || ' seconds')::interval, last_error = null, updated_at = now()
      where order_id = ${input.job.orderId} and claim_generation = ${current.claim_generation}
    `.execute(trx);
    return { row: current, generation: nextGeneration };
  });

  if (claimed === null) return { ok: false, code: "JOB_NOT_FOUND" };
  if (claimed === "STALE_JOB") return { ok: false, code: "STALE_JOB" };
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

  let sent: { fileId: string; fileUniqueId: string | null };
  try {
    sent = await input.sender.sendDocument({
      chatId: claimed.row.telegram_chat_id,
      filename: artifact.filename,
      mimeType: artifact.mime_type,
      caption: "Tệp số cho đơn hàng của bạn.",
      source,
    });
  } catch (error) {
    await markProcessingFailed(
      input.db,
      input.job.orderId,
      claimed.generation,
      error instanceof Error ? error.name : "SEND_FAILED",
    );
    return { ok: false, code: "SEND_FAILED" };
  }

  const updated = await withTransaction(input.db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, claimed.row.order_id);
    const fenced = await sql<JobRow>`
      update file_delivery_job
      set status = 'SENT', telegram_file_id = ${sent.fileId}, telegram_file_unique_id = ${sent.fileUniqueId},
          sent_at = now(), processing_expires_at = null, updated_at = now()
      where order_id = ${claimed.row.order_id}
        and status = 'PROCESSING'
        and claim_generation = ${claimed.generation}
        and artifact_id = ${claimed.row.artifact_id}
        and artifact_version = ${claimed.row.artifact_version}
        and artifact_sha256 = ${claimed.row.artifact_sha256}
      returning order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
                telegram_chat_id, status, telegram_file_id, telegram_file_unique_id, attempt_count,
                claim_generation, processing_expires_at
    `.execute(trx);
    const sentJob = fenced.rows[0];
    if (!sentJob) return null;
    await sql`
      update variant_file_artifact
      set telegram_file_id = coalesce(telegram_file_id, ${sent.fileId}),
          telegram_file_unique_id = coalesce(telegram_file_unique_id, ${sent.fileUniqueId})
      where id = ${claimed.row.artifact_id}
        and variant_id = ${claimed.row.artifact_variant_id}
        and version = ${claimed.row.artifact_version}
        and sha256 = ${claimed.row.artifact_sha256}
    `.execute(trx);
    if (order?.status === "PAID") {
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
    } else if (order?.status === "PROCESSING") {
      await transitionOrder(trx, order, "COMPLETED", "FILE_DELIVERY_SENT", "file-delivery", {
        type: "SYSTEM",
        id: "file-delivery",
      });
    }
    return mapJob(sentJob);
  });
  if (!updated) return { ok: false, code: "STALE_JOB" };
  return { ok: true, job: updated, reusedTelegramFileId: source.kind === "telegram_file_id" };
}
