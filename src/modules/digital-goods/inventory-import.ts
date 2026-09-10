import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import { INVENTORY_FIELDS_SCHEMA, type InventoryField } from "../catalog/fulfillment-type.js";

export const MAX_IMPORT_BYTES = 64 * 1024;
export const MAX_IMPORT_LINES = 500;
export type InventoryLineClassification =
  "READY" | "INVALID" | "UNKNOWN_VARIANT" | "DUPLICATE" | "MISSING_REQUIRED_FIELD";
export interface InventoryPreviewLine {
  line: number;
  variantId: string | null;
  classification: InventoryLineClassification;
  code: InventoryLineClassification;
}
export interface InventoryPreviewResult {
  lines: InventoryPreviewLine[];
  ready: number;
  invalid: number;
  duplicates: number;
}
export interface InventoryImportResult {
  imported: number;
  duplicates: number;
  invalid: number;
}

interface VariantInventoryImportResult extends InventoryImportResult {
  variantId: string;
}

function countVariantImport(
  counters: Map<string, VariantInventoryImportResult>,
  variantId: string,
  field: keyof InventoryImportResult,
): void {
  const current = counters.get(variantId) ?? { variantId, imported: 0, duplicates: 0, invalid: 0 };
  current[field] += 1;
  counters.set(variantId, current);
}

function postgresErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export interface InventoryImportInput {
  actor: RootActor;
  config: RootAdminConfig;
  vault: Vault;
  db: Db;
  input: string;
  reason: string;
  correlationId: string;
  announceStock?: boolean;
}

type ParsedLine = {
  variantId: string;
  credential: string;
  fingerprint: string;
  fieldValues?: string[];
  invalid?: true;
};

interface VariantInventoryConfig {
  id: string;
  inventoryFields: InventoryField[];
}

interface StoredInventoryFieldValue {
  name: string;
  value: string;
}

interface StoredInventorySecret {
  schemaVersion: "inventory-fields.v1";
  values: StoredInventoryFieldValue[];
}

function parseStoredInventoryFields(value: unknown): InventoryField[] {
  const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatInventoryImportTemplate(input: {
  inventoryFields: InventoryField[];
}): string {
  const fields =
    input.inventoryFields.length > 0
      ? input.inventoryFields
      : [
          {
            name: "credential",
            label: "Credential",
            required: true,
            secret: true,
            customerVisible: true,
          },
        ];
  const headers = fields.map((field) => field.name);
  const sample = fields.map(
    (field) => `<${field.name}${field.required ? ":required" : ":optional"}>`,
  );
  return `${headers.map(csvCell).join(",")}\n${sample.map(csvCell).join(",")}\n`;
}

function parseCredentialValues(row: ParsedLine, fields: InventoryField[]): StoredInventorySecret {
  if (fields.length === 0)
    return {
      schemaVersion: "inventory-fields.v1",
      values: [{ name: "credential", value: row.credential }],
    };
  if (fields.length === 1 && !row.fieldValues)
    return {
      schemaVersion: "inventory-fields.v1",
      values: [{ name: fields[0]!.name, value: row.credential }],
    };
  const parts = row.fieldValues ?? row.credential.split(":");
  return {
    schemaVersion: "inventory-fields.v1",
    values: fields.map((field, index) => ({
      name: field.name,
      value:
        index === fields.length - 1 && !row.fieldValues
          ? parts.slice(index).join(":")
          : (parts[index] ?? ""),
    })),
  };
}

function assetValidationSummary(fields: InventoryField[]): { inventoryFields: InventoryField[] } {
  return { inventoryFields: fields };
}

async function loadVariantInventoryConfigs(
  db: Db,
  variantIds: string[],
): Promise<Map<string, VariantInventoryConfig>> {
  if (variantIds.length === 0) return new Map();
  const variants = await sql<{ id: string; inventory_fields: unknown }>`
    select id, inventory_fields from product_variant where id in (${sql.join(variantIds)})
  `.execute(db);
  return new Map(
    variants.rows.map((row) => [
      row.id,
      { id: row.id, inventoryFields: parseStoredInventoryFields(row.inventory_fields) },
    ]),
  );
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

function parseLine(columns: string[]): ParsedLine | null {
  if (columns.length < 2) return null;
  const variantId = columns[0]!.trim();
  const credential = columns.length === 2 ? columns[1]!.trim() : columns.slice(1).join(":");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(variantId)) return null;
  if (credential.length === 0 || credential.length > 4096) {
    return { variantId, credential: "", fingerprint: "", invalid: true };
  }
  return {
    variantId,
    credential,
    fingerprint: createHash("sha256").update(credential, "utf8").digest("hex"),
    ...(columns.length > 2 ? { fieldValues: columns.slice(1) } : {}),
  };
}

function parseLines(raw: string): { parsed: (ParsedLine | null)[]; invalid: number } | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES || raw.includes("\0")) return null;
  const records = parseCsvRecords(raw);
  if (!records || records.length > MAX_IMPORT_LINES) return null;
  const parsed = records.map(parseLine);
  return { parsed, invalid: parsed.filter((row) => !row).length };
}

function isTemplatePlaceholder(value: string): boolean {
  return /^<[^>]+:(?:required|optional)>$/u.test(value.trim());
}

function missingRequiredField(row: ParsedLine, fields: InventoryField[]): boolean {
  if (!row.fieldValues || fields.length === 0) return false;
  return fields.some((field, index) => {
    const value = (row.fieldValues![index] ?? "").trim();
    return isTemplatePlaceholder(value) || (field.required && value.length === 0);
  });
}

function classifyLine(
  row: ParsedLine | null,
  knownFingerprints: Set<string>,
  variantConfigs: Map<string, VariantInventoryConfig>,
): InventoryLineClassification {
  if (!row) return "INVALID";
  if (row.invalid) return "INVALID";
  const config = variantConfigs.get(row.variantId);
  if (!config) return "UNKNOWN_VARIANT";
  if (missingRequiredField(row, config.inventoryFields)) return "MISSING_REQUIRED_FIELD";
  if (knownFingerprints.has(row.fingerprint)) return "DUPLICATE";
  return "READY";
}

/** Classifies rows without returning or persisting credential material. */
export async function previewDigitalInventory(
  input: Pick<InventoryImportInput, "db" | "actor" | "config" | "correlationId"> & {
    input: string;
  },
): Promise<
  InventoryPreviewResult | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" }
> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const parsed = parseLines(input.input);
  if (!parsed) return { ok: false, code: "INVALID_INPUT" };
  const rows = parsed.parsed.filter((row): row is ParsedLine => Boolean(row));
  const variantConfigs = await loadVariantInventoryConfigs(
    input.db,
    rows.map((row) => row.variantId),
  );
  const fingerprints = rows.map((row) => row.fingerprint);
  const existing = fingerprints.length
    ? await sql<{
        fingerprint_hash: string;
      }>`select fingerprint_hash from digital_asset where fingerprint_hash in (${sql.join(fingerprints)})`.execute(
        input.db,
      )
    : { rows: [] };
  const knownFingerprints = new Set(existing.rows.map((row) => row.fingerprint_hash));
  const lines = parsed.parsed.map((row, index) => {
    const classification = classifyLine(row, knownFingerprints, variantConfigs);
    return {
      line: index + 1,
      variantId: row?.variantId ?? null,
      classification,
      code: classification,
    } as InventoryPreviewLine;
  });
  return {
    lines,
    ready: lines.filter((line) => line.classification === "READY").length,
    invalid: lines.filter(
      (line) => line.classification !== "READY" && line.classification !== "DUPLICATE",
    ).length,
    duplicates: lines.filter((line) => line.classification === "DUPLICATE").length,
  };
}

/** Import bounded CSV rows. Credentials cross only the vault boundary. */
export async function importDigitalInventory(
  input: InventoryImportInput,
): Promise<
  | { ok: true; summary: InventoryImportResult }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" }
> {
  const gate = await guardRootAction(input.db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import",
    targetType: "DigitalAsset",
    targetId: "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const parsed = parseLines(input.input);
  if (!parsed) return { ok: false, code: "INVALID_INPUT" };
  const rows = parsed.parsed.filter((row): row is ParsedLine => Boolean(row));
  const variantConfigs = await loadVariantInventoryConfigs(
    input.db,
    rows.map((row) => row.variantId),
  );
  const summary: InventoryImportResult = { imported: 0, duplicates: 0, invalid: 0 };
  const perVariant = new Map<string, VariantInventoryImportResult>();
  for (const row of parsed.parsed) {
    if (!row) {
      summary.invalid += 1;
      continue;
    }
    if (row.invalid) {
      summary.invalid += 1;
      if (variantConfigs.has(row.variantId))
        countVariantImport(perVariant, row.variantId, "invalid");
      continue;
    }
    const config = variantConfigs.get(row.variantId);
    if (!config) {
      summary.invalid += 1;
      continue;
    }
    if (missingRequiredField(row, config.inventoryFields)) {
      summary.invalid += 1;
      countVariantImport(perVariant, row.variantId, "invalid");
      continue;
    }
    const storedSecret = parseCredentialValues(row, config.inventoryFields);
    const ref = await input.vault.write(JSON.stringify(storedSecret), {
      namespace: "asset",
      idempotencyKey: row.fingerprint,
    });
    try {
      await withTransaction(input.db, async (trx) => {
        await sql`select set_config('app.announce_stock', ${input.announceStock === true ? "true" : "false"}, true)`.execute(
          trx,
        );
        await sql`insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, validation_summary) values (${newId()}, ${row.variantId}, 'LOCAL', ${ref}, ${row.fingerprint}, 'AVAILABLE', ${JSON.stringify(assetValidationSummary(config.inventoryFields))}::jsonb)`.execute(
          trx,
        );
      });
      summary.imported += 1;
      countVariantImport(perVariant, row.variantId, "imported");
    } catch (error) {
      await input.vault.delete(ref);
      if (postgresErrorCode(error) !== "23505") throw error;
      summary.duplicates += 1;
      countVariantImport(perVariant, row.variantId, "duplicates");
    }
  }
  await appendAuditEvent(input.db, {
    actorType: "ROOT_ADMIN",
    actorId: String(input.actor.numericUserId),
    action: "inventory.import",
    targetType: "DigitalAsset",
    targetId: variantConfigs.size === 1 ? [...variantConfigs.keys()][0]! : "manual",
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      imported: summary.imported,
      duplicates: summary.duplicates,
      invalid: summary.invalid,
    },
  });
  if (variantConfigs.size > 1) {
    for (const row of perVariant.values()) {
      await appendAuditEvent(input.db, {
        actorType: "ROOT_ADMIN",
        actorId: String(input.actor.numericUserId),
        action: "inventory.import",
        targetType: "DigitalAsset",
        targetId: row.variantId,
        reason: input.reason,
        correlationId: input.correlationId,
        metadataRedacted: {
          imported: row.imported,
          duplicates: row.duplicates,
          invalid: row.invalid,
        },
      });
    }
  }
  return { ok: true, summary };
}
