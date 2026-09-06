import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";

export const MAX_IMPORT_BYTES = 64 * 1024;
export const MAX_IMPORT_LINES = 500;
export type InventoryLineClassification = "READY" | "INVALID" | "UNKNOWN_VARIANT" | "DUPLICATE";
export interface InventoryPreviewLine {
  line: number;
  variantId: string | null;
  classification: InventoryLineClassification;
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

type ParsedLine = { variantId: string; credential: string; fingerprint: string };

function parseLines(raw: string): { parsed: (ParsedLine | null)[]; invalid: number } | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES || raw.includes("\0")) return null;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_IMPORT_LINES) return null;
  return {
    parsed: lines.map((line) => {
      const comma = line.indexOf(",");
      const variantId = comma < 0 ? "" : line.slice(0, comma).trim();
      const credential = comma < 0 ? "" : line.slice(comma + 1).trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(variantId) || credential.length === 0 || credential.length > 4096)
        return null;
      return { variantId, credential, fingerprint: createHash("sha256").update(credential, "utf8").digest("hex") };
    }),
    invalid: lines.filter((line) => {
      const comma = line.indexOf(",");
      const variantId = comma < 0 ? "" : line.slice(0, comma).trim();
      const credential = comma < 0 ? "" : line.slice(comma + 1).trim();
      return !/^[A-Za-z0-9_-]{1,128}$/.test(variantId) || credential.length === 0 || credential.length > 4096;
    }).length,
  };
}

/** Classifies rows without returning or persisting credential material. */
export async function previewDigitalInventory(input: Pick<InventoryImportInput, "db" | "actor" | "config" | "correlationId"> & { input: string }): Promise<InventoryPreviewResult | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" }> {
  const gate = await guardRootAction(input.db, { actor: input.actor, config: input.config, correlationId: input.correlationId, action: "inventory.import.preview", targetType: "DigitalAsset", targetId: "manual" });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const parsed = parseLines(input.input);
  if (!parsed) return { ok: false, code: "INVALID_INPUT" };
  const variants = await sql<{ id: string }>`select id from product_variant where id in (${sql.join(parsed.parsed.filter(Boolean).map((row) => row!.variantId))})`.execute(input.db);
  const known = new Set(variants.rows.map((row) => row.id));
  const fingerprints = parsed.parsed.filter(Boolean).map((row) => row!.fingerprint);
  const existing = fingerprints.length ? await sql<{ fingerprint_hash: string }>`select fingerprint_hash from digital_asset where fingerprint_hash in (${sql.join(fingerprints)})`.execute(input.db) : { rows: [] };
  const knownFingerprints = new Set(existing.rows.map((row) => row.fingerprint_hash));
  const lines = parsed.parsed.map((row, index) => ({ line: index + 1, variantId: row?.variantId ?? null, classification: !row ? "INVALID" : !known.has(row.variantId) ? "UNKNOWN_VARIANT" : knownFingerprints.has(row.fingerprint) ? "DUPLICATE" : "READY" } as InventoryPreviewLine));
  return { lines, ready: lines.filter((line) => line.classification === "READY").length, invalid: lines.filter((line) => line.classification !== "READY" && line.classification !== "DUPLICATE").length, duplicates: lines.filter((line) => line.classification === "DUPLICATE").length };
}

/** Import bounded `variantId,credential` rows. Credentials cross only the vault boundary. */
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
  if (Buffer.byteLength(input.input, "utf8") > MAX_IMPORT_BYTES || input.input.includes("\0"))
    return { ok: false, code: "INVALID_INPUT" };
  const lines = input.input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_IMPORT_LINES) return { ok: false, code: "INVALID_INPUT" };
  const summary: InventoryImportResult = { imported: 0, duplicates: 0, invalid: 0 };
  for (const line of lines) {
    const comma = line.indexOf(",");
    const variantId = comma < 0 ? "" : line.slice(0, comma).trim();
    const credential = comma < 0 ? "" : line.slice(comma + 1).trim();
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(variantId) ||
      credential.length === 0 ||
      credential.length > 4096
    ) {
      summary.invalid += 1;
      continue;
    }
    const fingerprint = createHash("sha256").update(credential, "utf8").digest("hex");
    const ref = await input.vault.write(credential, {
      namespace: "asset",
      idempotencyKey: `inventory:${fingerprint}`,
    });
    try {
      await withTransaction(input.db, async (trx) => {
        await sql`select set_config('app.announce_stock', ${input.announceStock === true ? 'true' : 'false'}, true)`.execute(trx);
        await sql`insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status) values (${newId()}, ${variantId}, 'LOCAL', ${ref}, ${fingerprint}, 'AVAILABLE')`.execute(
          trx,
        );
      });
      summary.imported += 1;
    } catch (error) {
      await input.vault.delete(ref);
      if ((error as { code?: string }).code === "23505") summary.duplicates += 1;
      else throw error;
    }
  }
  await appendAuditEvent(input.db, {
    actorType: "ROOT_ADMIN",
    actorId: String(input.actor.numericUserId),
    action: "inventory.import",
    targetType: "DigitalAsset",
    targetId: "manual",
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: { imported: summary.imported, duplicates: summary.duplicates, invalid: summary.invalid },
  });
  return { ok: true, summary };
}
