import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import {
  importDigitalInventory,
  formatInventoryImportTemplate,
  previewDigitalInventory,
  type InventoryImportResult,
  type InventoryPreviewResult,
} from "./inventory-import.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import { INVENTORY_FIELDS_SCHEMA, type InventoryField } from "../catalog/fulfillment-type.js";
import { deleteAssetVaultRef, recordAssetVaultOrphan } from "./vault-orphan.js";
import { newId } from "../../shared/ids/index.js";

export const INVENTORY_IMPORT_TTL_SECONDS = 15 * 60;

export type InventoryImportStatus =
  "WAITING_INPUT" | "READY" | "PROCESSING" | "COMMITTED" | "CANCELLED";

export interface InventoryImportSession {
  adminTelegramUserId: string;
  generation: string;
  status: InventoryImportStatus;
  inputVaultRef: string | null;
  previewReady: number;
  previewInvalid: number;
  previewDuplicates: number;
  previewVariants: string[];
  selectedVariantId: string | null;
  expiresAt: number;
  importedAt?: number;
  cancelledAt?: number;
}

export interface InventoryImportAssetMetadata {
  sourceType?: string;
  costPriceVnd?: number;
  safeNote?: string;
}

export interface InventoryImportSessionInput {
  actor: RootActor;
  config: RootAdminConfig;
  correlationId: string;
  variantId?: string;
  assetMetadata?: InventoryImportAssetMetadata;
  /** Optional opaque ref binding for non-Telegram confirmation callers. */
  expectedInputVaultRef?: string;
  /** Optional session-generation binding for non-Telegram confirmation callers. */
  expectedGeneration?: string;
  /** Internal exact Sheets challenge owner for safe staged-ref cleanup. */
  expectedChallengeId?: string;
  allowExpiredProcessingRecovery?: boolean;
}

export interface InventoryImportTemplate {
  variantId: string;
  variantName: string;
  sku: string;
  csv: string;
  requiredFields: string[];
  optionalFields: string[];
}

interface SessionRow {
  admin_telegram_user_id: string;
  generation: string;
  status: InventoryImportStatus;
  input_vault_ref: string | null;
  preview_ready: number;
  preview_invalid: number;
  preview_duplicates: number;
  preview_variants: unknown;
  selected_variant_id: string | null;
  expires_at: Date | string;
  imported_at: Date | string | null;
  cancelled_at: Date | string | null;
}
export interface InventoryTextDocumentImport {
  filename: string;
  mimeType: string;
  fileSize?: number;
}

export interface InventoryTextDocumentDownloader {
  downloadText(fileId: string): Promise<string>;
}

const TEXT_DOCUMENT_EXTENSIONS = /\.(?:csv|txt)$/iu;
const TEXT_DOCUMENT_MIME_TYPES: Record<string, true> = {
  "application/csv": true,
  "text/csv": true,
  "text/plain": true,
};

function isAllowedTextDocument(input: InventoryTextDocumentImport): boolean {
  return (
    TEXT_DOCUMENT_EXTENSIONS.test(input.filename) ||
    TEXT_DOCUMENT_MIME_TYPES[input.mimeType] === true
  );
}

function ttlExpiry(now: number, ttlSeconds = INVENTORY_IMPORT_TTL_SECONDS): Date {
  return new Date(now + ttlSeconds * 1000);
}

function parsePreviewVariants(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function mapSession(row: SessionRow): InventoryImportSession {
  return {
    adminTelegramUserId: row.admin_telegram_user_id,
    generation: row.generation,
    status: row.status,
    inputVaultRef: row.input_vault_ref,
    previewReady: row.preview_ready,
    previewInvalid: row.preview_invalid,
    previewDuplicates: row.preview_duplicates,
    previewVariants: parsePreviewVariants(row.preview_variants),
    selectedVariantId: row.selected_variant_id,
    expiresAt: new Date(row.expires_at).getTime(),
    ...(row.imported_at ? { importedAt: new Date(row.imported_at).getTime() } : {}),
    ...(row.cancelled_at ? { cancelledAt: new Date(row.cancelled_at).getTime() } : {}),
  };
}

async function loadSession(
  exec: Executor,
  adminTelegramUserId: string,
): Promise<InventoryImportSession | null> {
  const result = await sql<SessionRow>`
    select admin_telegram_user_id, generation, status, input_vault_ref, preview_ready,
      preview_invalid, preview_duplicates, preview_variants, selected_variant_id, expires_at,
      imported_at, cancelled_at
    from admin_inventory_import
    where admin_telegram_user_id = ${adminTelegramUserId}
    limit 1
  `.execute(exec);
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function clearSession(exec: Executor, adminTelegramUserId: string): Promise<void> {
  await sql`delete from admin_inventory_import where admin_telegram_user_id = ${adminTelegramUserId}`.execute(
    exec,
  );
}

async function withBlockingSessionLock<T>(
  db: Db,
  adminTelegramUserId: string,
  fn: (exec: Db) => Promise<T>,
): Promise<T> {
  const lockKey = `inventory-import-session:${adminTelegramUserId}`;
  return db.connection().execute(async (connection) => {
    await sql`
      select pg_advisory_lock(hashtextextended(${lockKey}, 0))
    `.execute(connection);
    try {
      return await fn(connection);
    } finally {
      await sql`
        select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
      `.execute(connection);
    }
  });
}

async function withTrySessionLock<T>(
  db: Db,
  adminTelegramUserId: string,
  fn: (exec: Db) => Promise<T>,
): Promise<T | null> {
  const lockKey = `inventory-import-session:${adminTelegramUserId}`;
  return db.connection().execute(async (connection) => {
    const result = await sql<{ acquired: boolean }>`
      select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as acquired
    `.execute(connection);
    if (result.rows[0]?.acquired !== true) return null;
    try {
      return await fn(connection);
    } finally {
      await sql`
        select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
      `.execute(connection);
    }
  });
}

async function withBlockingRefLock<T>(
  exec: Db,
  inputVaultRef: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `inventory-import-input:${inputVaultRef}`;
  await sql`
    select pg_advisory_lock(hashtextextended(${lockKey}, 0))
  `.execute(exec);
  try {
    return await fn();
  } finally {
    await sql`
      select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
    `.execute(exec);
  }
}
interface InventoryImportVaultOwner {
  session?: { adminTelegramUserId: string; generation: string };
  challenge?: { id: string; generation: string };
}

async function deleteInventoryImportVaultRefLocked(
  exec: Db,
  vault: Vault,
  inputVaultRef: string,
  input: { correlationId: string; reason: string },
  owner?: InventoryImportVaultOwner,
): Promise<void> {
  const sessions = await sql<{
    admin_telegram_user_id: string;
    generation: string;
  }>`
    select admin_telegram_user_id, generation
    from admin_inventory_import
    where input_vault_ref = ${inputVaultRef}
      and status in ('READY', 'PROCESSING')
  `.execute(exec);
  const sessionOwner = owner?.session;
  if (
    sessions.rows.some(
      (row) =>
        !sessionOwner ||
        sessionOwner.adminTelegramUserId !== row.admin_telegram_user_id ||
        sessionOwner.generation !== row.generation,
    )
  )
    return;

  const challenges = await sql<{ id: string; generation: string }>`
    select id, generation
    from google_sheets_inventory_intake_challenge
    where input_vault_ref = ${inputVaultRef}
      and status in ('PREVIEWED', 'PROCESSING')
  `.execute(exec);
  const challengeOwner = owner?.challenge;
  if (
    challenges.rows.some(
      (row) =>
        !challengeOwner ||
        challengeOwner.id !== row.id ||
        challengeOwner.generation !== row.generation,
    )
  )
    return;

  await deleteAssetVaultRef(exec, vault, inputVaultRef, input);
}

export async function deleteInventoryImportVaultRef(
  db: Db,
  vault: Vault,
  inputVaultRef: string,
  input: { correlationId: string; reason: string },
  owner?: InventoryImportVaultOwner,
): Promise<void> {
  await withBlockingRefLock(db, inputVaultRef, () =>
    deleteInventoryImportVaultRefLocked(db, vault, inputVaultRef, input, owner),
  );
}
async function hasLiveInventoryImportRefOwner(
  exec: Executor,
  inputVaultRef: string,
): Promise<boolean> {
  const result = await sql<{ owned: boolean }>`
    select exists (
      select 1
      from admin_inventory_import
      where input_vault_ref = ${inputVaultRef}
        and status in ('READY', 'PROCESSING')
      union all
      select 1
      from google_sheets_inventory_intake_challenge
      where input_vault_ref = ${inputVaultRef}
        and status in ('PREVIEWED', 'PROCESSING')
    ) as owned
  `.execute(exec);
  return result.rows[0]?.owned === true;
}

async function recordAssetVaultOrphanIfUnowned(
  db: Db,
  inputVaultRef: string,
  input: { correlationId: string; reason: string },
): Promise<void> {
  await withBlockingRefLock(db, inputVaultRef, async () => {
    if (await hasLiveInventoryImportRefOwner(db, inputVaultRef)) return;
    await recordAssetVaultOrphan(db, inputVaultRef, input);
  });
}

async function hasProcessingSheetsChallenge(
  exec: Executor,
  adminTelegramUserId: string,
): Promise<boolean> {
  const result = await sql`
    select 1
    from google_sheets_inventory_intake_challenge
    where admin_telegram_user_id = ${adminTelegramUserId}
      and status = 'PROCESSING'
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

async function withTryRefLock<T>(
  exec: Db,
  inputVaultRef: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockKey = `inventory-import-input:${inputVaultRef}`;
  const result = await sql<{ acquired: boolean }>`
    select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as acquired
  `.execute(exec);
  if (result.rows[0]?.acquired !== true) return null;
  try {
    return await fn();
  } finally {
    await sql`
      select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
    `.execute(exec);
  }
}

function parseImportAuditSummary(value: unknown): InventoryImportResult | null {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const metadata = parsed as Record<string, unknown>;
  const imported = metadata.imported;
  const duplicates = metadata.duplicates;
  const invalid = metadata.invalid;
  if (
    typeof imported !== "number" ||
    !Number.isSafeInteger(imported) ||
    imported < 0 ||
    typeof duplicates !== "number" ||
    !Number.isSafeInteger(duplicates) ||
    duplicates < 0 ||
    typeof invalid !== "number" ||
    !Number.isSafeInteger(invalid) ||
    invalid < 0
  )
    return null;
  return { imported, duplicates, invalid };
}

async function priorImportAudit(
  exec: Executor,
  correlationId: string,
): Promise<InventoryImportResult | null> {
  const result = await sql<{ metadata_redacted: unknown }>`
    select metadata_redacted
    from audit_event
    where action = 'inventory.import' and correlation_id = ${correlationId}
    order by occurred_at asc, id asc
    limit 1
  `.execute(exec);
  return result.rows[0] ? parseImportAuditSummary(result.rows[0].metadata_redacted) : null;
}
function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseCsvRecords(raw: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quoted) {
      if (char === '"' && raw[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === ",") {
      record.push(cell.trim());
      cell = "";
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === "\n") {
      record.push(cell.trim());
      if (record.length > 1 || record.some((value) => value.length > 0)) records.push(record);
      record = [];
      cell = "";
    } else if (char === "\r") {
      continue;
    } else cell += char;
  }
  if (quoted) return null;
  record.push(cell.trim());
  if (record.length > 1 || record.some((value) => value.length > 0)) records.push(record);
  return records;
}

async function inventoryFieldsForSecretImportVariant(
  db: Db,
  variantId: string,
): Promise<InventoryField[] | null> {
  const variant = await sql<{ inventory_fields: unknown }>`
    select inventory_fields
    from product_variant
    where id = ${variantId}
      and fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE')
    limit 1
  `.execute(db);
  const row = variant.rows[0];
  if (!row) return null;
  const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(row.inventory_fields);
  return parsed.success ? parsed.data : [];
}
const FIELD_ALIASES: Record<string, string[]> = {
  email: ["email", "mail", "tài khoản", "tai khoan", "user", "username", "login", "tk"],
  password: ["password", "pass", "mật khẩu", "mat khau", "pwd", "mk"],
  recovery: [
    "recovery",
    "2fa",
    "khôi phục",
    "khoi phuc",
    "twofactor",
    "two_factor",
    "otp",
    "secret",
    "secret_key",
    "backup",
    "email khôi phục/2fa",
    "email khôi phục",
  ],
  username: ["username", "user", "tên đăng nhập", "ten dang nhap", "login"],
  code: ["code", "key", "license", "mã", "ma", "gift code", "giftcode"],
};

function matchFieldByLabel(
  label: string,
  fields: readonly InventoryField[],
): InventoryField | null {
  const norm = label.trim().toLowerCase();
  const exact = fields.find((f) => f.name.toLowerCase() === norm || f.label.toLowerCase() === norm);
  if (exact) return exact;

  for (const field of fields) {
    const aliases = FIELD_ALIASES[field.name.toLowerCase()] ?? [];
    if (aliases.some((a) => a === norm || norm.startsWith(a + " ") || norm.endsWith(" " + a))) {
      return field;
    }
  }
  return null;
}

function tryParseLabeledLines(
  rawInput: string,
  fields: readonly InventoryField[],
): string[][] | null {
  const lines = rawInput
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let hasAnyLabel = false;
  for (const line of lines) {
    const m = line.match(/^([^:=]{1,40})\s*[:=]\s*(.+)$/u);
    if (m && matchFieldByLabel(m[1]!, fields)) {
      hasAnyLabel = true;
      break;
    }
  }
  if (!hasAnyLabel) return null;

  const rawBlocks = rawInput
    .split(/\r?\n\s*\r?\n/u)
    .map((b) => b.trim())
    .filter(Boolean);
  const records: string[][] = [];

  for (const block of rawBlocks) {
    const blockLines = block
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter(Boolean);
    let currentMap: Record<string, string> = {};
    const flush = () => {
      if (Object.keys(currentMap).length > 0) {
        records.push(fields.map((f) => currentMap[f.name] ?? ""));
        currentMap = {};
      }
    };

    for (const line of blockLines) {
      const m = line.match(/^([^:=]{1,40})\s*[:=]\s*(.+)$/u);
      if (m) {
        const matched = matchFieldByLabel(m[1]!, fields);
        if (matched) {
          if (currentMap[matched.name] !== undefined) {
            flush();
          }
          currentMap[matched.name] = m[2]!.trim();
          continue;
        }
      }
    }
    flush();
  }

  return records.length > 0 ? records : null;
}

function normalizePartCount(parts: string[], expectedCount: number): string[] {
  if (expectedCount <= 1) return [parts.join(" ")];
  if (parts.length === expectedCount) return parts;
  if (parts.length < expectedCount) {
    return [...parts, ...Array(expectedCount - parts.length).fill("")];
  }
  const head = parts.slice(0, expectedCount - 1);
  const tail = parts.slice(expectedCount - 1).join(" ");
  return [...head, tail];
}

function splitLineByDelimiters(line: string, expectedCount: number): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // 1. Pipe: |
  if (trimmed.includes("|")) {
    const parts = trimmed.split("|").map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 2. Tab: \t
  if (trimmed.includes("\t")) {
    const parts = trimmed.split("\t").map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 3. Multi-dash: ---, ----, --
  if (/[-–—]{2,}/u.test(trimmed)) {
    const parts = trimmed.split(/\s*[-–—]{2,}\s*/u).map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 4. Double slash: //
  if (trimmed.includes("//")) {
    const parts = trimmed.split(/\s*\/\/\s*/u).map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 5. Slash with spaces: ' / '
  if (/\s+\/\s+/u.test(trimmed)) {
    const parts = trimmed.split(/\s+\/\s+/u).map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 6. Semicolon: ;
  if (trimmed.includes(";")) {
    const parts = trimmed.split(";").map((p) => p.trim());
    if (parts.length >= 2) return normalizePartCount(parts, expectedCount);
  }

  // 7. Colon: :
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map((p) => p.trim());
    if (parts.length >= 2) {
      return normalizePartCount(parts, expectedCount);
    }
  }

  // 8. Comma: ,
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length >= 2) {
      return normalizePartCount(parts, expectedCount);
    }
  }

  // 9. Whitespace: \s+
  const spaceParts = trimmed
    .split(/\s+/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (spaceParts.length >= 2) {
    return normalizePartCount(spaceParts, expectedCount);
  }

  return [trimmed];
}

function groupInputLines(rawInput: string, fields: readonly InventoryField[]): string[][] {
  const expectedCount = fields.length;
  const blocks = rawInput
    .split(/\r?\n\s*\r?\n/u)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length > 1) {
    return blocks.flatMap((block) => groupInputLines(block, fields));
  }

  const lines = rawInput
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    return [splitLineByDelimiters(lines[0]!, expectedCount)];
  }

  const isFirstFieldEmail =
    fields[0]?.name.toLowerCase().includes("email") ||
    fields[0]?.label.toLowerCase().includes("email");

  const lineParts = lines.map((l) => splitLineByDelimiters(l, expectedCount));

  if (lineParts.every((p) => p.length >= expectedCount)) {
    return lineParts;
  }

  const allTokens = lines.flatMap((l) =>
    l
      .split(/\s+/u)
      .map((t) => t.trim())
      .filter(Boolean),
  );
  if (allTokens.length === expectedCount) {
    return [allTokens];
  }

  if (isFirstFieldEmail) {
    const groupedRecords: string[][] = [];
    let currentTokens: string[] = [];
    for (const line of lines) {
      const tokens = line
        .split(/\s+/u)
        .map((t) => t.trim())
        .filter(Boolean);
      const startsWithEmail = tokens[0]?.includes("@");
      if (startsWithEmail && currentTokens.length > 0) {
        groupedRecords.push(normalizePartCount(currentTokens, expectedCount));
        currentTokens = [];
      }
      currentTokens.push(...tokens);
    }
    if (currentTokens.length > 0) {
      groupedRecords.push(normalizePartCount(currentTokens, expectedCount));
    }
    if (groupedRecords.length > 0 && groupedRecords.every((r) => r[0]?.includes("@"))) {
      return groupedRecords;
    }
  }

  if (
    lines.length % expectedCount === 0 &&
    lines.every((l) => !l.includes(" ") && !l.includes("|"))
  ) {
    const chunked: string[][] = [];
    for (let i = 0; i < lines.length; i += expectedCount) {
      chunked.push(lines.slice(i, i + expectedCount));
    }
    return chunked;
  }

  return lineParts;
}

export function bindSecretsToVariant(
  rawInput: string,
  variantId: string,
  fields: readonly InventoryField[],
): string {
  if (!rawInput.trim()) return "";

  // 1. Single field (e.g. code/key)
  if (fields.length <= 1) {
    const records = parseCsvRecords(rawInput);
    if (records && records.length > 0) {
      const [firstRecord, ...dataRecords] = records;
      if (firstRecord?.[0] === "variantId") {
        return dataRecords
          .map((record) => (record[0] === variantId ? record.map(csvCell).join(",") : ","))
          .join("\n");
      }
      if (firstRecord?.[0] === fields[0]?.name) {
        return dataRecords
          .map((record) => [variantId, ...record].map(csvCell).join(","))
          .join("\n");
      }
    }
    const lines = rawInput
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((line) => [variantId, line].map(csvCell).join(",")).join("\n");
  }

  // 2. Official CSV template headers (variantId or matching field names)
  const records = parseCsvRecords(rawInput);
  if (records && records.length > 0) {
    const [firstRecord, ...dataRecords] = records;
    const firstCell = firstRecord?.[0] ?? "";
    if (firstCell === "variantId") {
      return dataRecords
        .map((record) => (record[0] === variantId ? record.map(csvCell).join(",") : ","))
        .join("\n");
    }
    if (firstRecord) {
      const fieldIndexByHeader = fields.map((field) => firstRecord.indexOf(field.name));
      if (
        firstRecord.length === fields.length &&
        fieldIndexByHeader.every((index) => index >= 0) &&
        new Set(fieldIndexByHeader).size === fields.length
      ) {
        return dataRecords
          .map((record) =>
            [variantId, ...fieldIndexByHeader.map((index) => record[index] ?? "")]
              .map(csvCell)
              .join(","),
          )
          .join("\n");
      }
    }
  }

  // 3. Labeled input (e.g. Email: ... \n Password: ...)
  const labeled = tryParseLabeledLines(rawInput, fields);
  if (labeled) {
    return labeled.map((row) => [variantId, ...row].map(csvCell).join(",")).join("\n");
  }

  // 4. Delimited lines or chunked multi-line input
  const rows = groupInputLines(rawInput, fields);
  if (rows.length > 0) {
    return rows.map((row) => [variantId, ...row].map(csvCell).join(",")).join("\n");
  }

  return [variantId, rawInput.trim()].map(csvCell).join(",");
}

function selectedVariantFrom(session: InventoryImportSession): string | null {
  return session.selectedVariantId;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
async function isSecretImportVariant(db: Db, variantId: string): Promise<boolean> {
  return (await inventoryFieldsForSecretImportVariant(db, variantId)) !== null;
}
export async function createInventoryImportTemplate(
  db: Db,
  input: InventoryImportSessionInput,
): Promise<
  | { ok: true; template: InventoryImportTemplate }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "NOT_FOUND" }
> {
  if (!input.variantId) return { ok: false, code: "NOT_FOUND" };
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: input.variantId,
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const variant = await sql<{ name: string; sku: string; inventory_fields: unknown }>`
    select name_vi as name, sku, inventory_fields
    from product_variant
    where id = ${input.variantId}
      and fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE')
    limit 1
  `.execute(db);
  const row = variant.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND" };
  const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(row.inventory_fields);
  const fields = parsed.success ? parsed.data : [];
  return {
    ok: true,
    template: {
      variantId: input.variantId,
      variantName: row.name,
      sku: row.sku,
      csv: formatInventoryImportTemplate({ inventoryFields: fields }),
      requiredFields: fields.filter((field) => field.required).map((field) => field.name),
      optionalFields: fields.filter((field) => !field.required).map((field) => field.name),
    },
  };
}

export async function startInventoryImportSession(
  db: Db,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<
  | { ok: true; session: InventoryImportSession }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "BUSY" }
> {
  if (input.variantId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.variantId))
    return { ok: false, code: "NOT_ROOT_ADMIN" };
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: input.variantId ?? "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  if (input.variantId && !(await isSecretImportVariant(db, input.variantId)))
    return { ok: false, code: "NOT_ROOT_ADMIN" };
  const session: InventoryImportSession = {
    adminTelegramUserId: String(input.actor.numericUserId),
    generation: newId(),
    status: "WAITING_INPUT",
    inputVaultRef: null,
    previewReady: 0,
    previewInvalid: 0,
    previewDuplicates: 0,
    previewVariants: input.variantId ? [input.variantId] : [],
    selectedVariantId: input.variantId ?? null,
    expiresAt: ttlExpiry(now).getTime(),
  };
  const started = await withBlockingSessionLock(db, session.adminTelegramUserId, async (exec) => {
    const existing = await loadSession(exec, session.adminTelegramUserId);
    if (
      existing?.status === "PROCESSING" ||
      (await hasProcessingSheetsChallenge(exec, session.adminTelegramUserId)) ||
      (existing?.status === "READY" && existing.inputVaultRef !== null)
    )
      return false;
    await sql`
      insert into admin_inventory_import
        (admin_telegram_user_id, generation, status, input_vault_ref, preview_ready, preview_invalid,
         preview_duplicates, preview_variants, selected_variant_id, expires_at, updated_at)
      values (${session.adminTelegramUserId}, ${session.generation}, ${session.status}, null, 0, 0, 0, ${JSON.stringify(session.previewVariants)}::jsonb,
        ${session.selectedVariantId}, ${new Date(session.expiresAt).toISOString()}, now())
      on conflict (admin_telegram_user_id) do update set
        generation = excluded.generation,
        status = excluded.status,
        input_vault_ref = null,
        preview_ready = 0,
        preview_invalid = 0,
        preview_duplicates = 0,
        preview_variants = ${JSON.stringify(session.previewVariants)}::jsonb,
        selected_variant_id = excluded.selected_variant_id,
        expires_at = excluded.expires_at,
        imported_at = null,
        cancelled_at = null,
        updated_at = now()
    `.execute(exec);
    return true;
  });
  if (!started) return { ok: false, code: "BUSY" };
  return { ok: true, session };
}

export async function cancelInventoryImportSession(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<
  | { ok: true; cancelled: boolean }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "NOT_FOUND" | "BUSY" }
> {
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const adminTelegramUserId = String(input.actor.numericUserId);
  return withBlockingSessionLock(db, adminTelegramUserId, async (exec) => {
    const session = await loadSession(exec, adminTelegramUserId);
    if (!session) return { ok: false as const, code: "NOT_FOUND" as const };
    if (
      session.status === "PROCESSING" ||
      (await hasProcessingSheetsChallenge(exec, adminTelegramUserId))
    )
      return { ok: false as const, code: "BUSY" as const };
    if (input.expectedInputVaultRef !== undefined || input.expectedGeneration !== undefined) {
      if (
        session.status !== "READY" ||
        (input.expectedInputVaultRef !== undefined &&
          session.inputVaultRef !== input.expectedInputVaultRef) ||
        (input.expectedGeneration !== undefined && session.generation !== input.expectedGeneration)
      )
        return { ok: true as const, cancelled: false as const };
    }
    if (session.inputVaultRef) {
      await withBlockingRefLock(exec, session.inputVaultRef, () =>
        deleteInventoryImportVaultRefLocked(
          exec,
          vault,
          session.inputVaultRef!,
          {
            correlationId: input.correlationId,
            reason: "inventory import cancellation",
          },
          { session: { adminTelegramUserId, generation: session.generation } },
        ),
      );
    }
    await clearSession(exec, adminTelegramUserId);
    await sql`
      insert into admin_inventory_import
        (admin_telegram_user_id, generation, status, input_vault_ref, preview_ready, preview_invalid,
         preview_duplicates, preview_variants, expires_at, cancelled_at, updated_at)
      values (${adminTelegramUserId}, ${session.generation}, 'CANCELLED', null, 0, 0, 0, '[]'::jsonb,
        ${new Date(now).toISOString()}, ${new Date(now).toISOString()}, now())
      on conflict (admin_telegram_user_id) do update set
        generation = excluded.generation,
        status = 'CANCELLED',
        input_vault_ref = null,
        preview_ready = 0,
        preview_invalid = 0,
        preview_duplicates = 0,
        preview_variants = '[]'::jsonb,
        expires_at = excluded.expires_at,
        imported_at = null,
        cancelled_at = excluded.cancelled_at,
        updated_at = now()
    `.execute(exec);
    return { ok: true as const, cancelled: true as const };
  });
}

export async function stageInventoryImportInput(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput & { rawInput: string },
  now = Date.now(),
): Promise<
  | { ok: true; preview: InventoryPreviewResult; inputVaultRef: string; generation: string }
  | {
      ok: false;
      code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND" | "EXPIRED";
    }
> {
  const adminTelegramUserId = String(input.actor.numericUserId);
  const session = await loadSession(db, adminTelegramUserId);
  if (!session) return { ok: false, code: "NOT_FOUND" };
  if (input.expectedGeneration !== undefined && session.generation !== input.expectedGeneration)
    return { ok: false, code: "NOT_FOUND" };
  const selectedVariantId = selectedVariantFrom(session);
  if (session.status !== "WAITING_INPUT" && session.status !== "READY")
    return { ok: false, code: "NOT_FOUND" };
  if (
    input.variantId !== undefined &&
    (session.status !== "WAITING_INPUT" || selectedVariantId !== input.variantId)
  )
    return { ok: false, code: "NOT_FOUND" };
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: selectedVariantId ?? "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  if (session.expiresAt <= now) {
    return withBlockingSessionLock(db, adminTelegramUserId, async (exec) => {
      const current = await loadSession(exec, adminTelegramUserId);
      if (
        !current ||
        current.generation !== session.generation ||
        current.status !== session.status ||
        current.inputVaultRef !== session.inputVaultRef ||
        current.selectedVariantId !== session.selectedVariantId ||
        current.expiresAt > now
      )
        return { ok: false as const, code: "NOT_FOUND" as const };
      if (current.inputVaultRef) {
        await withBlockingRefLock(exec, current.inputVaultRef, () =>
          deleteInventoryImportVaultRefLocked(
            exec,
            vault,
            current.inputVaultRef!,
            {
              correlationId: input.correlationId,
              reason: "inventory import expired preview",
            },
            { session: { adminTelegramUserId, generation: current.generation } },
          ),
        );
      }
      await clearSession(exec, adminTelegramUserId);
      return { ok: false as const, code: "EXPIRED" as const };
    });
  }
  const selectedVariantFields = selectedVariantId
    ? await inventoryFieldsForSecretImportVariant(db, selectedVariantId)
    : null;
  if (selectedVariantId && !selectedVariantFields) return { ok: false, code: "INVALID_INPUT" };
  const normalizedInput = selectedVariantId
    ? bindSecretsToVariant(input.rawInput, selectedVariantId, selectedVariantFields ?? [])
    : input.rawInput;
  if (!normalizedInput.trim()) return { ok: false, code: "INVALID_INPUT" };
  const preview = await previewDigitalInventory({
    db,
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    input: normalizedInput,
  });
  if (!("ready" in preview)) return preview;
  const rawHash = sha256(`${session.adminTelegramUserId}:${session.generation}:${normalizedInput}`);
  const vaultRef = await vault.write(normalizedInput, {
    namespace: "asset",
    idempotencyKey: rawHash,
  });
  const existingRef = session.inputVaultRef;
  try {
    const bound = await withBlockingSessionLock(db, adminTelegramUserId, async (exec) =>
      withBlockingRefLock(exec, vaultRef, async () => {
        const result = await sql<{ admin_telegram_user_id: string }>`
          update admin_inventory_import
          set status = 'READY',
              input_vault_ref = ${vaultRef},
              preview_ready = ${preview.ready},
              preview_invalid = ${preview.invalid},
              preview_duplicates = ${preview.duplicates},
              preview_variants = ${JSON.stringify(preview.lines.map((line) => line.variantId).filter((variantId): variantId is string => Boolean(variantId)))}::jsonb,
              expires_at = ${ttlExpiry(now).toISOString()},
              imported_at = null,
              cancelled_at = null,
              updated_at = now()
          where admin_telegram_user_id = ${adminTelegramUserId}
            and generation = ${session.generation}
            and status = ${session.status}
            and input_vault_ref is not distinct from ${session.inputVaultRef}
            and selected_variant_id is not distinct from ${session.selectedVariantId}
          returning admin_telegram_user_id
        `.execute(exec);
        if (result.rows.length === 0) return false;
        if (existingRef && existingRef !== vaultRef) {
          await withBlockingRefLock(exec, existingRef, () =>
            deleteInventoryImportVaultRefLocked(
              exec,
              vault,
              existingRef,
              {
                correlationId: input.correlationId,
                reason: "inventory import superseded preview",
              },
              { session: { adminTelegramUserId, generation: session.generation } },
            ),
          );
        }
        return true;
      }),
    );
    if (!bound) {
      if (existingRef !== vaultRef) {
        await recordAssetVaultOrphanIfUnowned(db, vaultRef, {
          correlationId: input.correlationId,
          reason: "inventory import session superseded before bind",
        });
      }
      return { ok: false, code: "NOT_FOUND" };
    }
  } catch (error) {
    await recordAssetVaultOrphanIfUnowned(db, vaultRef, {
      correlationId: input.correlationId,
      reason: "inventory import session bind failed",
    });
    throw error;
  }
  return { ok: true, preview, inputVaultRef: vaultRef, generation: session.generation };
}
export async function stageInventoryImportDocument(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput & {
    document: InventoryTextDocumentImport & { fileId: string };
    downloader: InventoryTextDocumentDownloader;
  },
  now = Date.now(),
): Promise<
  | { ok: true; preview: InventoryPreviewResult; inputVaultRef: string; generation: string }
  | {
      ok: false;
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "EXPIRED"
        | "UNSUPPORTED_DOCUMENT";
    }
> {
  if (!isAllowedTextDocument(input.document)) return { ok: false, code: "UNSUPPORTED_DOCUMENT" };
  if (input.document.fileSize !== undefined && input.document.fileSize > 64 * 1024)
    return { ok: false, code: "INVALID_INPUT" };
  const rawInput = await input.downloader.downloadText(input.document.fileId);
  return stageInventoryImportInput(db, vault, { ...input, rawInput }, now);
}

type ConfirmSessionOutcome =
  | { kind: "AUTH"; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" }
  | { kind: "BUSY" }
  | { kind: "NOT_FOUND" }
  | { kind: "MISMATCH" }
  | { kind: "NOT_READY" }
  | { kind: "EXPIRED"; session: InventoryImportSession }
  | { kind: "COMMITTED"; session: InventoryImportSession }
  | { kind: "FAILED"; code: "INVALID_INPUT" | "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" }
  | { kind: "OK"; summary: InventoryImportResult; reused: boolean };

export async function confirmInventoryImportSession(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<
  | { ok: true; summary: InventoryImportResult; reused: boolean }
  | {
      ok: false;
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "NOT_READY"
        | "BUSY"
        | "EXPIRED";
    }
> {
  const adminTelegramUserId = String(input.actor.numericUserId);
  const recoveryRequested =
    input.allowExpiredProcessingRecovery === true &&
    input.expectedGeneration !== undefined &&
    input.expectedInputVaultRef !== undefined;
  const outcome = await withTrySessionLock<ConfirmSessionOutcome>(
    db,
    adminTelegramUserId,
    async (connection) => {
      const audited = recoveryRequested
        ? await priorImportAudit(connection, input.correlationId)
        : null;
      const session = await loadSession(connection, adminTelegramUserId);
      const gate = await guardRootAction(connection, {
        actor: input.actor,
        config: input.config,
        correlationId: input.correlationId,
        action: "inventory.import",
        targetType: "DigitalAsset",
        targetId: session?.selectedVariantId ?? "manual",
      });
      if (!gate.ok) return { kind: "AUTH" as const, code: gate.reason };
      if (audited) {
        const expectedGeneration = input.expectedGeneration;
        const expectedInputVaultRef = input.expectedInputVaultRef;
        if (!expectedGeneration || !expectedInputVaultRef) return { kind: "MISMATCH" as const };
        if (
          session &&
          session.generation === expectedGeneration &&
          session.inputVaultRef === expectedInputVaultRef &&
          (session.status === "READY" || session.status === "PROCESSING")
        ) {
          await sql`
            update admin_inventory_import
            set status = 'COMMITTED', imported_at = now(), updated_at = now()
            where admin_telegram_user_id = ${adminTelegramUserId}
              and generation = ${expectedGeneration}
              and status in ('READY', 'PROCESSING')
              and input_vault_ref = ${expectedInputVaultRef}
          `.execute(connection);
        }
        await withBlockingRefLock(connection, expectedInputVaultRef, () =>
          deleteInventoryImportVaultRefLocked(
            connection,
            vault,
            expectedInputVaultRef,
            {
              correlationId: input.correlationId,
              reason: "inventory import commit reconciliation",
            },
            {
              session: { adminTelegramUserId, generation: expectedGeneration },
              ...(input.expectedChallengeId
                ? {
                    challenge: {
                      id: input.expectedChallengeId,
                      generation: expectedGeneration,
                    },
                  }
                : {}),
            },
          ),
        );
        return { kind: "OK" as const, reused: true, summary: audited };
      }

      const prepared = await withTransaction(connection, async (trx) => {
        const result = await sql<SessionRow>`
          select admin_telegram_user_id, generation, status, input_vault_ref, preview_ready,
            preview_invalid, preview_duplicates, preview_variants, selected_variant_id, expires_at,
            imported_at, cancelled_at
          from admin_inventory_import
          where admin_telegram_user_id = ${adminTelegramUserId}
          for update
        `.execute(trx);
        const row = result.rows[0];
        if (!row) return { kind: "NOT_FOUND" as const };
        const current = mapSession(row);
        if (
          (input.expectedInputVaultRef !== undefined &&
            current.inputVaultRef !== input.expectedInputVaultRef) ||
          (input.expectedGeneration !== undefined &&
            current.generation !== input.expectedGeneration)
        )
          return { kind: "MISMATCH" as const };
        const recoverySession =
          recoveryRequested &&
          current.inputVaultRef === input.expectedInputVaultRef &&
          current.generation === input.expectedGeneration &&
          (current.status === "READY" || current.status === "PROCESSING");
        if (current.expiresAt <= now && !recoverySession)
          return { kind: "EXPIRED" as const, session: current };
        if (current.status === "COMMITTED") return { kind: "COMMITTED" as const, session: current };
        if (
          (current.status !== "READY" && current.status !== "PROCESSING") ||
          !current.inputVaultRef
        )
          return { kind: "NOT_READY" as const };
        if (current.status === "READY") {
          await sql`
            update admin_inventory_import
            set status = 'PROCESSING', updated_at = now()
            where admin_telegram_user_id = ${adminTelegramUserId}
              and generation = ${current.generation}
              and status = 'READY'
              and input_vault_ref = ${current.inputVaultRef}
          `.execute(trx);
        }
        return { kind: "CLAIMED" as const, session: current };
      });

      if (prepared.kind === "NOT_FOUND") return prepared;
      if (prepared.kind === "MISMATCH") return prepared;
      if (prepared.kind === "NOT_READY") return prepared;
      if (prepared.kind === "EXPIRED") {
        if (prepared.session.status === "WAITING_INPUT" || prepared.session.status === "READY") {
          if (prepared.session.inputVaultRef) {
            await withBlockingRefLock(connection, prepared.session.inputVaultRef, () =>
              deleteInventoryImportVaultRefLocked(
                connection,
                vault,
                prepared.session.inputVaultRef!,
                {
                  correlationId: input.correlationId,
                  reason: "inventory import confirmation expired",
                },
                {
                  session: {
                    adminTelegramUserId,
                    generation: prepared.session.generation,
                  },
                  ...(input.expectedChallengeId
                    ? {
                        challenge: {
                          id: input.expectedChallengeId,
                          generation: prepared.session.generation,
                        },
                      }
                    : {}),
                },
              ),
            );
          }
          await clearSession(connection, adminTelegramUserId);
        }
        return prepared;
      }
      if (prepared.kind === "COMMITTED") {
        const committedAudit = await priorImportAudit(connection, input.correlationId);
        if (prepared.session.inputVaultRef) {
          await withBlockingRefLock(connection, prepared.session.inputVaultRef, () =>
            deleteInventoryImportVaultRefLocked(
              connection,
              vault,
              prepared.session.inputVaultRef!,
              {
                correlationId: input.correlationId,
                reason: "inventory import commit reconciliation",
              },
              input.expectedChallengeId
                ? {
                    challenge: {
                      id: input.expectedChallengeId,
                      generation: prepared.session.generation,
                    },
                  }
                : undefined,
            ),
          );
        }
        return {
          kind: "OK" as const,
          reused: true,
          summary: committedAudit ?? {
            imported: 0,
            duplicates: prepared.session.previewDuplicates,
            invalid: prepared.session.previewInvalid,
          },
        };
      }

      const inputVaultRef = prepared.session.inputVaultRef;
      if (!inputVaultRef) return { kind: "NOT_READY" as const };
      // Keep a stable staged-input lock while the idempotent importer calls Vault and PostgreSQL.
      // This is a session-level advisory lock, not a long-lived database transaction.
      const locked = await withTryRefLock(connection, inputVaultRef, async () => {
        const committedAudit = await priorImportAudit(connection, input.correlationId);
        let summary: InventoryImportResult;
        let reused = false;
        if (committedAudit) {
          summary = committedAudit;
          reused = true;
        } else {
          const rawInput = await vault.reveal(inputVaultRef);
          const imported = await importDigitalInventory({
            actor: input.actor,
            config: input.config,
            vault,
            db: connection,
            input: rawInput,
            reason: input.assetMetadata ? "Sheets inventory import" : "Admin inventory import",
            correlationId: input.correlationId,
            ...input.assetMetadata,
          });
          if (!imported.ok) {
            await sql`
              update admin_inventory_import
              set status = 'READY', updated_at = now()
              where admin_telegram_user_id = ${adminTelegramUserId}
                and generation = ${prepared.session.generation}
                and status = 'PROCESSING'
                and input_vault_ref = ${inputVaultRef}
            `.execute(connection);
            return { kind: "FAILED" as const, code: imported.code };
          }
          summary = imported.summary;
        }

        const committed = await sql<{ admin_telegram_user_id: string }>`
          update admin_inventory_import
          set status = 'COMMITTED', imported_at = now(), updated_at = now()
          where admin_telegram_user_id = ${adminTelegramUserId}
            and generation = ${prepared.session.generation}
            and status = 'PROCESSING'
            and input_vault_ref = ${inputVaultRef}
          returning admin_telegram_user_id
        `.execute(connection);
        if (committed.rows.length === 0) return { kind: "MISMATCH" as const };
        await deleteInventoryImportVaultRefLocked(
          connection,
          vault,
          inputVaultRef,
          {
            correlationId: input.correlationId,
            reason: "inventory import committed",
          },
          {
            session: {
              adminTelegramUserId,
              generation: prepared.session.generation,
            },
            ...(input.expectedChallengeId
              ? {
                  challenge: {
                    id: input.expectedChallengeId,
                    generation: prepared.session.generation,
                  },
                }
              : {}),
          },
        );
        return { kind: "OK" as const, reused, summary };
      });
      return locked ?? { kind: "BUSY" as const };
    },
  );

  if (!outcome) return { ok: false, code: "BUSY" };
  if (outcome.kind === "BUSY") return { ok: false, code: "BUSY" };
  if (outcome.kind === "AUTH") return { ok: false, code: outcome.code };
  if (outcome.kind === "NOT_FOUND") return { ok: false, code: "NOT_FOUND" };
  if (outcome.kind === "MISMATCH" || outcome.kind === "NOT_READY")
    return { ok: false, code: "NOT_READY" };
  if (outcome.kind === "EXPIRED") return { ok: false, code: "EXPIRED" };
  if (outcome.kind === "FAILED") return { ok: false, code: outcome.code };
  if (outcome.kind === "COMMITTED") {
    return {
      ok: true,
      reused: true,
      summary: {
        imported: 0,
        duplicates: outcome.session.previewDuplicates,
        invalid: outcome.session.previewInvalid,
      },
    };
  }
  return { ok: true, reused: outcome.reused, summary: outcome.summary };
}

export async function getInventoryImportSession(
  db: Db,
  adminTelegramUserId: string,
  now = Date.now(),
): Promise<InventoryImportSession | null> {
  const session = await loadSession(db, adminTelegramUserId);
  if (!session) return null;
  if (session.expiresAt <= now) {
    if (session.status === "PROCESSING") return session;
    const cleared = await sql`
      delete from admin_inventory_import
      where admin_telegram_user_id = ${adminTelegramUserId}
        and generation = ${session.generation}
        and status = ${session.status}
        and input_vault_ref is not distinct from ${session.inputVaultRef}
        and selected_variant_id is not distinct from ${session.selectedVariantId}
        and expires_at = ${new Date(session.expiresAt).toISOString()}
    `.execute(db);
    if (cleared.numAffectedRows !== 1n) return loadSession(db, adminTelegramUserId);
    return null;
  }
  return session;
}
