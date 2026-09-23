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

export const INVENTORY_IMPORT_TTL_SECONDS = 15 * 60;

export type InventoryImportStatus =
  "WAITING_INPUT" | "READY" | "PROCESSING" | "COMMITTED" | "CANCELLED";

export interface InventoryImportSession {
  adminTelegramUserId: string;
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
    select admin_telegram_user_id, status, input_vault_ref, preview_ready,
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
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" }
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
    status: "WAITING_INPUT",
    inputVaultRef: null,
    previewReady: 0,
    previewInvalid: 0,
    previewDuplicates: 0,
    previewVariants: input.variantId ? [input.variantId] : [],
    selectedVariantId: input.variantId ?? null,
    expiresAt: ttlExpiry(now).getTime(),
  };
  await sql`
    insert into admin_inventory_import
      (admin_telegram_user_id, status, input_vault_ref, preview_ready, preview_invalid,
       preview_duplicates, preview_variants, selected_variant_id, expires_at, updated_at)
    values (${session.adminTelegramUserId}, ${session.status}, null, 0, 0, 0, ${JSON.stringify(session.previewVariants)}::jsonb,
      ${session.selectedVariantId}, ${new Date(session.expiresAt).toISOString()}, now())
    on conflict (admin_telegram_user_id) do update set
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
  `.execute(db);
  return { ok: true, session };
}

export async function cancelInventoryImportSession(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<
  | { ok: true; cancelled: boolean }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "NOT_FOUND" }
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
  const session = await loadSession(db, String(input.actor.numericUserId));
  if (!session) return { ok: false, code: "NOT_FOUND" };
  if (session.inputVaultRef) {
    await deleteAssetVaultRef(db, vault, session.inputVaultRef, {
      correlationId: input.correlationId,
      reason: "inventory import cancellation",
    });
  }
  await clearSession(db, String(input.actor.numericUserId));
  await sql`
    insert into admin_inventory_import
      (admin_telegram_user_id, status, input_vault_ref, preview_ready, preview_invalid,
       preview_duplicates, preview_variants, expires_at, cancelled_at, updated_at)
    values (${String(input.actor.numericUserId)}, 'CANCELLED', null, 0, 0, 0, '[]'::jsonb,
      ${new Date(now).toISOString()}, ${new Date(now).toISOString()}, now())
    on conflict (admin_telegram_user_id) do update set
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
  `.execute(db);
  return { ok: true, cancelled: true };
}

export async function stageInventoryImportInput(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput & { rawInput: string },
  now = Date.now(),
): Promise<
  | { ok: true; preview: InventoryPreviewResult }
  | {
      ok: false;
      code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND" | "EXPIRED";
    }
> {
  const session = await loadSession(db, String(input.actor.numericUserId));
  if (!session) return { ok: false, code: "NOT_FOUND" };
  const selectedVariantId = selectedVariantFrom(session);
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
    if (session.inputVaultRef) {
      await deleteAssetVaultRef(db, vault, session.inputVaultRef, {
        correlationId: input.correlationId,
        reason: "inventory import expired preview",
      });
    }
    await clearSession(db, String(input.actor.numericUserId));
    return { ok: false, code: "EXPIRED" };
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
  const rawHash = sha256(normalizedInput);
  const vaultRef = await vault.write(normalizedInput, {
    namespace: "asset",
    idempotencyKey: rawHash,
  });
  const existingRef = session.inputVaultRef;
  try {
    await sql`
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
      where admin_telegram_user_id = ${String(input.actor.numericUserId)}
    `.execute(db);
  } catch (error) {
    await recordAssetVaultOrphan(db, vaultRef, {
      correlationId: input.correlationId,
      reason: "inventory import session bind failed",
    });
    throw error;
  }
  if (existingRef && existingRef !== vaultRef) {
    await deleteAssetVaultRef(db, vault, existingRef, {
      correlationId: input.correlationId,
      reason: "inventory import superseded preview",
    });
  }
  return { ok: true, preview };
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
  | { ok: true; preview: InventoryPreviewResult }
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
  const session = await loadSession(db, String(input.actor.numericUserId));
  const selectedVariantId = session?.selectedVariantId ?? null;
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import",
    targetType: "DigitalAsset",
    targetId: selectedVariantId ?? "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };

  const adminTelegramUserId = String(input.actor.numericUserId);
  const prepared = await withTransaction(db, async (trx) => {
    const result = await sql<SessionRow>`
      select admin_telegram_user_id, status, input_vault_ref, preview_ready,
        preview_invalid, preview_duplicates, preview_variants, expires_at,
        imported_at, cancelled_at
      from admin_inventory_import
      where admin_telegram_user_id = ${adminTelegramUserId}
      for update
    `.execute(trx);
    const row = result.rows[0];
    if (!row) return null;
    const session = mapSession(row);
    if (session.expiresAt <= now) return { expired: true as const, session };
    if (session.status === "COMMITTED") return { committed: true as const, session };
    if (session.status === "PROCESSING") return { busy: true as const, session };
    if (session.status !== "READY" || !session.inputVaultRef)
      return { ready: false as const, session };
    await sql`
      update admin_inventory_import
      set status = 'PROCESSING', updated_at = now()
      where admin_telegram_user_id = ${adminTelegramUserId}
    `.execute(trx);
    return { ready: true as const, session };
  });

  if (!prepared) return { ok: false, code: "NOT_FOUND" };
  if ("expired" in prepared) {
    if (prepared.session.inputVaultRef) {
      await deleteAssetVaultRef(db, vault, prepared.session.inputVaultRef, {
        correlationId: input.correlationId,
        reason: "inventory import confirmation expired",
      });
    }
    await clearSession(db, adminTelegramUserId);
    return { ok: false, code: "EXPIRED" };
  }
  if ("committed" in prepared) {
    return {
      ok: true,
      reused: true,
      summary: {
        imported: 0,
        duplicates: prepared.session.previewDuplicates,
        invalid: prepared.session.previewInvalid,
      },
    };
  }
  if ("busy" in prepared) return { ok: false, code: "BUSY" };
  if (!prepared.session.inputVaultRef) return { ok: false, code: "NOT_READY" };
  if (!prepared.ready) return { ok: false, code: "NOT_READY" };

  try {
    const rawInput = await vault.reveal(prepared.session.inputVaultRef);
    const result = await importDigitalInventory({
      actor: input.actor,
      config: input.config,
      vault,
      db,
      input: rawInput,
      reason: input.assetMetadata ? "Sheets inventory import" : "Admin inventory import",
      correlationId: input.correlationId,
      ...input.assetMetadata,
    });
    if (!result.ok) {
      await sql`
        update admin_inventory_import
        set status = 'READY', updated_at = now()
        where admin_telegram_user_id = ${adminTelegramUserId}
      `.execute(db);
      return { ok: false, code: result.code };
    }
    await sql`
      update admin_inventory_import
      set status = 'COMMITTED', input_vault_ref = null, imported_at = now(), updated_at = now()
      where admin_telegram_user_id = ${adminTelegramUserId}
    `.execute(db);
    await deleteAssetVaultRef(db, vault, prepared.session.inputVaultRef, {
      correlationId: input.correlationId,
      reason: "inventory import committed",
    });
    return { ok: true, reused: false, summary: result.summary };
  } catch (error) {
    await sql`
      update admin_inventory_import
      set status = 'READY', updated_at = now()
      where admin_telegram_user_id = ${adminTelegramUserId}
    `.execute(db);
    throw error;
  }
}

export async function getInventoryImportSession(
  db: Db,
  adminTelegramUserId: string,
  now = Date.now(),
): Promise<InventoryImportSession | null> {
  const session = await loadSession(db, adminTelegramUserId);
  if (!session) return null;
  if (session.expiresAt <= now) {
    await clearSession(db, adminTelegramUserId);
    return null;
  }
  return session;
}
