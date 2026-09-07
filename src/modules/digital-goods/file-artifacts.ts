import { sql } from "kysely";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";

const SHA256 = /^[a-f0-9]{64}$/;
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{20,512}$/;
const TELEGRAM_FILE_UNIQUE_ID = /^[A-Za-z0-9_-]{4,256}$/;
const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 127;
const MAX_STORAGE_REFERENCE_LENGTH = 1_024;
const MAX_SIZE_BYTES = 5_000_000_000n;

type FileArtifactRow = {
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

export interface AdminFileArtifactInput {
  actor: RootActor;
  config: RootAdminConfig;
  db: Db;
  variantId: string;
  reason: string;
  correlationId: string;
}

export interface RegisterFileArtifactInput extends AdminFileArtifactInput {
  version: number;
  filename: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  storageReference: string;
}

export interface ActivateFileArtifactInput extends AdminFileArtifactInput {
  artifactId: string;
}

export interface CacheTelegramFileInput extends AdminFileArtifactInput {
  artifactId: string;
  version: number;
  sha256: string;
  telegramFileId: string;
  telegramFileUniqueId?: string | null;
}

export interface FileArtifactMetadata {
  id: string;
  variantId: string;
  version: number;
  filename: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  isActive: boolean;
  createdAt: string;
}

export type FileArtifactResult =
  | { ok: true; artifact: FileArtifactMetadata }
  | {
      ok: false;
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "INVALID_INPUT"
        | "VARIANT_NOT_DIGITAL_FILE"
        | "VERSION_CONFLICT"
        | "TELEGRAM_CACHE_CONFLICT"
        | "ARTIFACT_NOT_FOUND";
    };

export type SelectedFileArtifactForDelivery = Pick<
  FileArtifactMetadata,
  | "id"
  | "variantId"
  | "version"
  | "filename"
  | "mimeType"
  | "sizeBytes"
  | "sha256"
  | "telegramFileId"
  | "telegramFileUniqueId"
>;

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapArtifact(row: FileArtifactRow): FileArtifactMetadata {
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
    createdAt: toIso(row.created_at),
  };
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code <= 31;
  });
}

function validText(value: string, max: number): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max && !hasControlCharacter(trimmed);
}

export function isValidFileArtifactRegistrationMetadata(input: {
  version: number;
  filename: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
  storageReference: string;
  reason: string;
}): boolean {
  return (
    Number.isInteger(input.version) &&
    input.version > 0 &&
    validText(input.filename, MAX_FILENAME_LENGTH) &&
    validText(input.mimeType, MAX_MIME_TYPE_LENGTH) &&
    input.mimeType.includes("/") &&
    input.sizeBytes > 0n &&
    input.sizeBytes <= MAX_SIZE_BYTES &&
    SHA256.test(input.sha256) &&
    validText(input.storageReference, MAX_STORAGE_REFERENCE_LENGTH) &&
    validText(input.reason, 500)
  );
}

function validateRegister(input: RegisterFileArtifactInput): boolean {
  return isValidFileArtifactRegistrationMetadata(input);
}

function validateCache(input: CacheTelegramFileInput): boolean {
  return (
    input.version > 0 &&
    SHA256.test(input.sha256) &&
    TELEGRAM_FILE_ID.test(input.telegramFileId) &&
    (input.telegramFileUniqueId == null ||
      TELEGRAM_FILE_UNIQUE_ID.test(input.telegramFileUniqueId)) &&
    validText(input.reason, 500)
  );
}

async function authorize(
  input: AdminFileArtifactInput,
  action: string,
  targetId: string,
): Promise<FileArtifactResult | null> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action,
    targetType: "VariantFileArtifact",
    targetId,
  });
  return gate.ok ? null : { ok: false, code: gate.reason };
}

async function ensureDigitalFileVariant(exec: Executor, variantId: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one from product_variant
    where id = ${variantId} and fulfillment_type = 'DIGITAL_FILE'
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

function sameRegisteredArtifact(row: FileArtifactRow, input: RegisterFileArtifactInput): boolean {
  return (
    row.filename === input.filename.trim() &&
    row.mime_type === input.mimeType.trim() &&
    BigInt(row.size_bytes) === input.sizeBytes &&
    row.sha256 === input.sha256 &&
    row.storage_reference === input.storageReference.trim()
  );
}

export async function registerFileArtifact(
  input: RegisterFileArtifactInput,
): Promise<FileArtifactResult> {
  if (!validateRegister(input)) return { ok: false, code: "INVALID_INPUT" };
  const denied = await authorize(
    input,
    "file_artifact.register",
    `${input.variantId}:${input.version}`,
  );
  if (denied) return denied;

  return withTransaction(input.db, async (trx) => {
    if (!(await ensureDigitalFileVariant(trx, input.variantId)))
      return { ok: false, code: "VARIANT_NOT_DIGITAL_FILE" };

    const existing = await sql<FileArtifactRow>`
      select id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
             storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
      from variant_file_artifact
      where variant_id = ${input.variantId} and version = ${input.version}
      limit 1
    `.execute(trx);
    const row = existing.rows[0];
    if (row) {
      return sameRegisteredArtifact(row, input)
        ? { ok: true, artifact: mapArtifact(row) }
        : { ok: false, code: "VERSION_CONFLICT" };
    }

    const id = newId();
    const inserted = await sql<FileArtifactRow>`
      insert into variant_file_artifact
        (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, is_active)
      values
        (${id}, ${input.variantId}, ${input.version}, ${input.filename.trim()}, ${input.mimeType.trim()},
         ${input.sizeBytes.toString()}, ${input.sha256}, ${input.storageReference.trim()}, false)
      returning id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
                storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
    `.execute(trx);
    const artifact = mapArtifact(inserted.rows[0]!);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "file_artifact.registered",
      targetType: "VariantFileArtifact",
      targetId: artifact.id,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: artifact.variantId,
        version: artifact.version,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes.toString(),
      },
    });
    return { ok: true, artifact };
  });
}

export async function activateFileArtifact(
  input: ActivateFileArtifactInput,
): Promise<FileArtifactResult> {
  if (!validText(input.reason, 500)) return { ok: false, code: "INVALID_INPUT" };
  const denied = await authorize(input, "file_artifact.activate", input.artifactId);
  if (denied) return denied;

  return withTransaction(input.db, async (trx) => {
    const existing = await sql<FileArtifactRow>`
      select id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
             storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
      from variant_file_artifact
      where id = ${input.artifactId} and variant_id = ${input.variantId}
      limit 1
      for update
    `.execute(trx);
    const row = existing.rows[0];
    if (!row) return { ok: false, code: "ARTIFACT_NOT_FOUND" };
    if (!(await ensureDigitalFileVariant(trx, input.variantId)))
      return { ok: false, code: "VARIANT_NOT_DIGITAL_FILE" };
    if (row.is_active) return { ok: true, artifact: mapArtifact(row) };

    await sql`update variant_file_artifact set is_active = false where variant_id = ${input.variantId} and id <> ${input.artifactId} and is_active`.execute(
      trx,
    );
    const activated = await sql<FileArtifactRow>`
      update variant_file_artifact set is_active = true
      where id = ${input.artifactId}
      returning id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
                storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
    `.execute(trx);
    const artifact = mapArtifact(activated.rows[0]!);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "file_artifact.activated",
      targetType: "VariantFileArtifact",
      targetId: artifact.id,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: artifact.variantId,
        version: artifact.version,
        sha256: artifact.sha256,
      },
    });
    return { ok: true, artifact };
  });
}

export async function cacheTelegramFileId(
  input: CacheTelegramFileInput,
): Promise<FileArtifactResult> {
  if (!validateCache(input)) return { ok: false, code: "INVALID_INPUT" };
  const denied = await authorize(input, "file_artifact.telegram_cache", input.artifactId);
  if (denied) return denied;

  return withTransaction(input.db, async (trx) => {
    const current = await sql<FileArtifactRow>`
      select id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
             storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
      from variant_file_artifact
      where id = ${input.artifactId}
        and variant_id = ${input.variantId}
        and version = ${input.version}
        and sha256 = ${input.sha256}
      limit 1
      for update
    `.execute(trx);
    const row = current.rows[0];
    if (!row) return { ok: false, code: "ARTIFACT_NOT_FOUND" };
    if (
      row.telegram_file_id === input.telegramFileId &&
      row.telegram_file_unique_id === (input.telegramFileUniqueId ?? null)
    ) {
      return { ok: true, artifact: mapArtifact(row) };
    }
    if (row.telegram_file_id !== null) return { ok: false, code: "TELEGRAM_CACHE_CONFLICT" };

    const updated = await sql<FileArtifactRow>`
      update variant_file_artifact
      set telegram_file_id = ${input.telegramFileId},
          telegram_file_unique_id = ${input.telegramFileUniqueId ?? null}
      where id = ${input.artifactId}
      returning id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
                storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
    `.execute(trx);
    const artifact = mapArtifact(updated.rows[0]!);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "file_artifact.telegram_cached",
      targetType: "VariantFileArtifact",
      targetId: artifact.id,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: artifact.variantId,
        version: artifact.version,
        sha256: artifact.sha256,
        telegramFileUniqueId: artifact.telegramFileUniqueId,
      },
    });
    return { ok: true, artifact };
  });
}

export async function getActiveFileArtifactForDelivery(
  exec: Executor,
  variantId: string,
): Promise<SelectedFileArtifactForDelivery | null> {
  const result = await sql<FileArtifactRow>`
    select id, variant_id, version, filename, mime_type, size_bytes::text as size_bytes, sha256,
           storage_reference, telegram_file_id, telegram_file_unique_id, is_active, created_at
    from variant_file_artifact
    where variant_id = ${variantId} and is_active
    order by version desc, created_at desc, id desc
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  const artifact = mapArtifact(row);
  return {
    id: artifact.id,
    variantId: artifact.variantId,
    version: artifact.version,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    telegramFileId: artifact.telegramFileId,
    telegramFileUniqueId: artifact.telegramFileUniqueId,
  };
}
