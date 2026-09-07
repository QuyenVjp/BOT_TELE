import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import {
  isValidFileArtifactRegistrationMetadata,
  type FileArtifactMetadata,
} from "./file-artifacts.js";

export const TELEGRAM_FILE_IMPORT_MAX_BYTES = 20_000_000n;
const TTL_SECONDS = 900;

type SessionStatus = "WAITING_DOCUMENT" | "READY" | "COMMITTED" | "CANCELLED";

export type FileArtifactImportSession = {
  sessionId: string;
  adminTelegramUserId: string;
  variantId: string;
  status: SessionStatus;
  generation: number;
  artifactId: string | null;
  artifactVersion: number | null;
  artifactSha256: string | null;
  filename: string | null;
};

type SessionRow = {
  id: string;
  admin_telegram_user_id: string;
  variant_id: string;
  status: SessionStatus;
  generation: number;
  artifact_id: string | null;
  artifact_version: number | null;
  artifact_sha256: string | null;
  filename: string | null;
};

type ArtifactRow = {
  id: string;
  variant_id: string;
  version: number;
  filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_reference: string;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  is_active: boolean;
  created_at: Date | string;
};

export interface TelegramDocumentImport {
  fileId: string;
  fileUniqueId?: string | null;
  filename: string;
  mimeType: string;
  fileSize?: number;
}

export interface TelegramFileDownloader {
  download(input: {
    fileId: string;
    root: string;
    maxBytes: bigint;
  }): Promise<{ storageReference: string; sizeBytes: bigint; sha256: string }>;
}

function mapSession(row: SessionRow): FileArtifactImportSession {
  return {
    sessionId: row.id,
    adminTelegramUserId: row.admin_telegram_user_id,
    variantId: row.variant_id,
    status: row.status,
    generation: row.generation,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    artifactSha256: row.artifact_sha256,
    filename: row.filename,
  };
}

function mapArtifact(row: ArtifactRow): FileArtifactMetadata {
  return {
    id: row.id,
    variantId: row.variant_id,
    version: row.version,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: BigInt(row.size_bytes),
    sha256: row.sha256,
    telegramFileId: row.telegram_file_id,
    telegramFileUniqueId: row.telegram_file_unique_id,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function ensureRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  return realpath(root);
}

async function resolvePrivatePath(storageReference: string, root: string): Promise<string | null> {
  let ref = storageReference;
  if (ref.startsWith("file://")) {
    try {
      const url = new URL(ref);
      if (url.host) return null;
      ref = fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (ref.includes("\0") || !ref.startsWith("/")) return null;
  const [path, privateRoot] = await Promise.all([
    realpath(ref).catch(() => null),
    realpath(root).catch(() => null),
  ]);
  return path && privateRoot && isInsideRoot(path, privateRoot) ? path : null;
}

async function verifyPrivateFile(input: {
  storageReference: string;
  root: string;
  sizeBytes: bigint;
  sha256: string;
  maxBytes: bigint;
}): Promise<boolean> {
  if (input.sizeBytes > input.maxBytes) return false;
  const path = await resolvePrivatePath(input.storageReference, input.root);
  if (!path) return false;
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || BigInt(stat.size) !== input.sizeBytes) return false;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let remaining = input.sizeBytes + 1n;
    while (remaining > 0n) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(remaining)),
        null,
      );
      if (bytesRead === 0) break;
      if (BigInt(bytesRead) > remaining - 1n) return false;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
    return remaining === 1n && hash.digest("hex") === input.sha256;
  } finally {
    await file.close();
  }
}

export function createTelegramFileDownloader(botToken: string): TelegramFileDownloader {
  return {
    async download(input) {
      try {
        const metaResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: input.fileId }),
        });
        if (!metaResponse.ok) throw new Error("TELEGRAM_FILE_UNAVAILABLE");
        const meta = (await metaResponse.json()) as {
          ok?: boolean;
          result?: { file_path?: unknown; file_size?: unknown };
        };
        const filePath =
          meta.ok && typeof meta.result?.file_path === "string" ? meta.result.file_path : null;
        const fileSize =
          typeof meta.result?.file_size === "number" &&
          Number.isSafeInteger(meta.result.file_size) &&
          meta.result.file_size > 0
            ? BigInt(meta.result.file_size)
            : null;
        if (
          !filePath ||
          filePath.includes("..") ||
          filePath.startsWith("/") ||
          (fileSize !== null && fileSize > input.maxBytes)
        )
          throw new Error("TELEGRAM_FILE_UNAVAILABLE");

        const root = await ensureRoot(input.root);
        const storageReference = resolve(root, `${randomUUID()}-${basename(filePath)}`);
        if (!isInsideRoot(storageReference, root)) throw new Error("TELEGRAM_FILE_UNAVAILABLE");
        const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok || !response.body) throw new Error("TELEGRAM_FILE_UNAVAILABLE");

        const hash = createHash("sha256");
        let size = 0n;
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
            size += BigInt(bytes.byteLength);
            if (size > input.maxBytes) callback(new Error("TELEGRAM_FILE_TOO_LARGE"));
            else {
              hash.update(bytes);
              callback(null, bytes);
            }
          },
        });
        const file = await open(storageReference, "wx", 0o600);
        try {
          await pipeline(Readable.fromWeb(response.body), counter, file.createWriteStream());
        } catch (error) {
          await file.close().catch(() => undefined);
          await unlink(storageReference).catch(() => undefined);
          throw error;
        }
        await file.close();
        return { storageReference, sizeBytes: size, sha256: hash.digest("hex") };
      } catch {
        throw new Error("TELEGRAM_FILE_UNAVAILABLE");
      }
    },
  };
}

async function authorize(
  db: Db,
  actor: RootActor,
  config: RootAdminConfig,
  targetId: string,
  correlationId: string,
) {
  return guardRootAction(db, {
    actor,
    config,
    correlationId,
    action: "file_artifact.import",
    targetType: "ProductVariant",
    targetId,
  });
}

export async function startFileArtifactImportSession(
  db: Db,
  input: { actor: RootActor; config: RootAdminConfig; variantId: string; correlationId: string },
) {
  const gate = await authorize(db, input.actor, input.config, input.variantId, input.correlationId);
  if (!gate.ok) return { ok: false as const, code: gate.reason };
  return withTransaction(db, async (trx) => {
    const variant = await sql<{
      one: number;
    }>`select 1 as one from product_variant where id=${input.variantId} and fulfillment_type='DIGITAL_FILE' and is_active limit 1 for update`.execute(
      trx,
    );
    if (!variant.rows[0]) return { ok: false as const, code: "VARIANT_NOT_DIGITAL_FILE" as const };
    const id = newId();
    const inserted = await sql<SessionRow>`
      insert into admin_file_artifact_import (id, admin_telegram_user_id, variant_id, status, generation, expires_at, updated_at)
      values (${id}, ${String(input.actor.numericUserId)}, ${input.variantId}, 'WAITING_DOCUMENT', 1, now() + make_interval(secs => ${TTL_SECONDS}), now())
      on conflict (admin_telegram_user_id) do update set id=${id}, variant_id=excluded.variant_id, status='WAITING_DOCUMENT', generation=admin_file_artifact_import.generation + 1, artifact_id=null, artifact_version=null, artifact_sha256=null, filename=null, expires_at=excluded.expires_at, updated_at=now()
      returning id, admin_telegram_user_id, variant_id, status, generation, artifact_id, artifact_version, artifact_sha256, filename
    `.execute(trx);
    return { ok: true as const, session: mapSession(inserted.rows[0]!) };
  });
}

export async function getFileArtifactImportSession(
  db: Db,
  adminTelegramUserId: string,
): Promise<FileArtifactImportSession | null> {
  const row = (
    await sql<SessionRow>`
    select id, admin_telegram_user_id, variant_id, status, generation, artifact_id, artifact_version, artifact_sha256, filename
    from admin_file_artifact_import
    where admin_telegram_user_id=${adminTelegramUserId} and status in ('WAITING_DOCUMENT','READY') and expires_at > now()
    limit 1
  `.execute(db)
  ).rows[0];
  return row ? mapSession(row) : null;
}

export async function stageFileArtifactDocument(
  db: Db,
  input: {
    actor: RootActor;
    config: RootAdminConfig;
    sessionId: string;
    generation: number;
    document: TelegramDocumentImport;
    downloader: TelegramFileDownloader;
    privateArtifactRoot: string;
    correlationId: string;
  },
) {
  const session = (
    await sql<SessionRow>`select id, admin_telegram_user_id, variant_id, status, generation, artifact_id, artifact_version, artifact_sha256, filename from admin_file_artifact_import where id=${input.sessionId} and admin_telegram_user_id=${String(input.actor.numericUserId)} and generation=${input.generation} and status='WAITING_DOCUMENT' and expires_at > now()`.execute(
      db,
    )
  ).rows[0];
  if (!session) return { ok: false as const, code: "NOT_FOUND" as const };
  const gate = await authorize(
    db,
    input.actor,
    input.config,
    session.variant_id,
    input.correlationId,
  );
  if (!gate.ok) return { ok: false as const, code: gate.reason };
  if (!input.privateArtifactRoot) return { ok: false as const, code: "NO_PRIVATE_ROOT" as const };
  if (
    input.document.fileSize !== undefined &&
    BigInt(input.document.fileSize) > TELEGRAM_FILE_IMPORT_MAX_BYTES
  )
    return { ok: false as const, code: "FILE_TOO_LARGE" as const };
  const downloaded = await input.downloader.download({
    fileId: input.document.fileId,
    root: input.privateArtifactRoot,
    maxBytes: TELEGRAM_FILE_IMPORT_MAX_BYTES,
  });

  let keepFile = false;
  const result = await withTransaction(db, async (trx) => {
    await sql`select 1 from product_variant where id=${session.variant_id} and fulfillment_type='DIGITAL_FILE' for update`.execute(
      trx,
    );
    const locked = (
      await sql<SessionRow>`select id, admin_telegram_user_id, variant_id, status, generation, artifact_id, artifact_version, artifact_sha256, filename from admin_file_artifact_import where id=${input.sessionId} and admin_telegram_user_id=${String(input.actor.numericUserId)} and generation=${input.generation} and status='WAITING_DOCUMENT' and expires_at > now() for update`.execute(
        trx,
      )
    ).rows[0];
    if (!locked) return { ok: false as const, code: "NOT_FOUND" as const };
    const version = (
      await sql<{
        version: number;
      }>`select coalesce(max(version), 0)::int + 1 as version from variant_file_artifact where variant_id=${locked.variant_id}`.execute(
        trx,
      )
    ).rows[0]!.version;
    const reason = "Telegram document file import";
    if (
      !isValidFileArtifactRegistrationMetadata({
        version,
        filename: input.document.filename,
        mimeType: input.document.mimeType,
        sizeBytes: downloaded.sizeBytes,
        sha256: downloaded.sha256,
        storageReference: downloaded.storageReference,
        reason,
      })
    )
      return { ok: false as const, code: "INVALID_INPUT" as const };
    const artifactId = newId();
    const inserted = await sql<ArtifactRow>`
      insert into variant_file_artifact (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, telegram_file_id, telegram_file_unique_id, is_active)
      values (${artifactId}, ${locked.variant_id}, ${version}, ${input.document.filename.trim()}, ${input.document.mimeType.trim()}, ${downloaded.sizeBytes.toString()}, ${downloaded.sha256}, ${downloaded.storageReference}, ${input.document.fileId}, ${input.document.fileUniqueId ?? null}, false)
      returning id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256, storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
    `.execute(trx);
    const artifact = mapArtifact(inserted.rows[0]!);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "file_artifact.registered",
      targetType: "VariantFileArtifact",
      targetId: artifact.id,
      reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: artifact.variantId,
        version: artifact.version,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes.toString(),
      },
    });
    await sql`update admin_file_artifact_import set status='READY', artifact_id=${artifact.id}, artifact_version=${artifact.version}, artifact_sha256=${artifact.sha256}, filename=${artifact.filename}, updated_at=now() where id=${locked.id}`.execute(
      trx,
    );
    keepFile = true;
    return {
      ok: true as const,
      artifact,
      session: {
        ...mapSession(locked),
        status: "READY" as const,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactSha256: artifact.sha256,
        filename: artifact.filename,
      },
    };
  });
  if (!keepFile) await unlink(downloaded.storageReference).catch(() => undefined);
  return result;
}

export async function confirmFileArtifactImportSession(
  db: Db,
  input: {
    actor: RootActor;
    config: RootAdminConfig;
    sessionId: string;
    generation: number;
    artifactId: string;
    privateArtifactRoot: string;
    correlationId: string;
  },
) {
  const session = (
    await sql<SessionRow & { storage_reference: string; size_bytes: string }>`
    select s.id, s.admin_telegram_user_id, s.variant_id, s.status, s.generation, s.artifact_id, s.artifact_version, s.artifact_sha256, s.filename, a.storage_reference, a.size_bytes::text as size_bytes
    from admin_file_artifact_import s
    join variant_file_artifact a on a.id = s.artifact_id and a.variant_id = s.variant_id and a.version = s.artifact_version and a.sha256 = s.artifact_sha256
    where s.id=${input.sessionId} and s.generation=${input.generation} and s.artifact_id=${input.artifactId} and s.admin_telegram_user_id=${String(input.actor.numericUserId)} and s.status='READY' and s.expires_at > now()
  `.execute(db)
  ).rows[0];
  if (!session?.artifact_id || session.artifact_version === null || !session.artifact_sha256)
    return { ok: false as const, code: "NOT_READY" as const };
  const gate = await authorize(
    db,
    input.actor,
    input.config,
    session.variant_id,
    input.correlationId,
  );
  if (!gate.ok) return { ok: false as const, code: gate.reason };
  const verified = await verifyPrivateFile({
    storageReference: session.storage_reference,
    root: input.privateArtifactRoot,
    sizeBytes: BigInt(session.size_bytes),
    sha256: session.artifact_sha256,
    maxBytes: TELEGRAM_FILE_IMPORT_MAX_BYTES,
  });
  if (!verified) return { ok: false as const, code: "FILE_NOT_VERIFIED" as const };

  return withTransaction(db, async (trx) => {
    await sql`select 1 from product_variant where id=${session.variant_id} and fulfillment_type='DIGITAL_FILE' for update`.execute(
      trx,
    );
    const row = (
      await sql<ArtifactRow>`
      select a.id, a.variant_id, a.version, a.filename, a.mime_type, a.size_bytes::text as size_bytes, a.sha256, a.storage_reference, a.telegram_file_id, a.telegram_file_unique_id, a.is_active, a.created_at
      from admin_file_artifact_import s
      join variant_file_artifact a on a.id = s.artifact_id and a.variant_id = s.variant_id and a.version = s.artifact_version and a.sha256 = s.artifact_sha256
      where s.id=${input.sessionId} and s.generation=${input.generation} and s.artifact_id=${input.artifactId} and s.admin_telegram_user_id=${String(input.actor.numericUserId)} and s.status='READY' and s.expires_at > now()
      for update of s, a
    `.execute(trx)
    ).rows[0];
    if (!row) return { ok: false as const, code: "NOT_READY" as const };
    await sql`update variant_file_artifact set is_active=false where variant_id=${row.variant_id} and id <> ${row.id} and is_active`.execute(
      trx,
    );
    const activated = (
      await sql<ArtifactRow>`update variant_file_artifact set is_active=true where id=${row.id} returning id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256, storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at`.execute(
        trx,
      )
    ).rows[0]!;
    const artifact = mapArtifact(activated);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "file_artifact.activated",
      targetType: "VariantFileArtifact",
      targetId: artifact.id,
      reason: "Telegram document file import confirmed",
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: artifact.variantId,
        version: artifact.version,
        sha256: artifact.sha256,
      },
    });
    await sql`update admin_file_artifact_import set status='COMMITTED', updated_at=now() where id=${input.sessionId}`.execute(
      trx,
    );
    return { ok: true as const, artifact };
  });
}

export async function cancelFileArtifactImportSession(
  db: Db,
  input: { actor: RootActor; config: RootAdminConfig; correlationId: string },
) {
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "file_artifact.import.cancel",
    targetType: "VariantFileArtifact",
    targetId: String(input.actor.numericUserId),
  });
  if (!gate.ok) return { ok: false as const, code: gate.reason };
  await sql`update admin_file_artifact_import set status='CANCELLED', artifact_id=null, artifact_version=null, artifact_sha256=null, filename=null, updated_at=now() where admin_telegram_user_id=${String(input.actor.numericUserId)} and status in ('WAITING_DOCUMENT','READY')`.execute(
    db,
  );
  return { ok: true as const };
}
