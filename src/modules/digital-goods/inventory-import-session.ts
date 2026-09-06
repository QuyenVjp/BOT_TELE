import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import {
  importDigitalInventory,
  previewDigitalInventory,
  type InventoryImportResult,
  type InventoryPreviewResult,
} from "./inventory-import.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";

export const INVENTORY_IMPORT_TTL_SECONDS = 15 * 60;

export type InventoryImportStatus = "WAITING_INPUT" | "READY" | "PROCESSING" | "COMMITTED" | "CANCELLED";

export interface InventoryImportSession {
  adminTelegramUserId: string;
  status: InventoryImportStatus;
  inputVaultRef: string | null;
  previewReady: number;
  previewInvalid: number;
  previewDuplicates: number;
  previewVariants: string[];
  expiresAt: number;
  importedAt?: number;
  cancelledAt?: number;
}

export interface InventoryImportSessionInput {
  actor: RootActor;
  config: RootAdminConfig;
  correlationId: string;
}

interface SessionRow {
  admin_telegram_user_id: string;
  status: InventoryImportStatus;
  input_vault_ref: string | null;
  preview_ready: number;
  preview_invalid: number;
  preview_duplicates: number;
  preview_variants: unknown;
  expires_at: Date | string;
  imported_at: Date | string | null;
  cancelled_at: Date | string | null;
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
    expiresAt: new Date(row.expires_at).getTime(),
    ...(row.imported_at ? { importedAt: new Date(row.imported_at).getTime() } : {}),
    ...(row.cancelled_at ? { cancelledAt: new Date(row.cancelled_at).getTime() } : {}),
  };
}

async function loadSession(exec: Executor, adminTelegramUserId: string): Promise<InventoryImportSession | null> {
  const result = await sql<SessionRow>`
    select admin_telegram_user_id, status, input_vault_ref, preview_ready,
      preview_invalid, preview_duplicates, preview_variants, expires_at,
      imported_at, cancelled_at
    from admin_inventory_import
    where admin_telegram_user_id = ${adminTelegramUserId}
    limit 1
  `.execute(exec);
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

async function clearSession(exec: Executor, adminTelegramUserId: string): Promise<void> {
  await sql`delete from admin_inventory_import where admin_telegram_user_id = ${adminTelegramUserId}`.execute(exec);
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export async function startInventoryImportSession(
  db: Db,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<{ ok: true; session: InventoryImportSession } | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" }> {
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import.preview",
    targetType: "DigitalAsset",
    targetId: "manual",
  });
  if (!gate.ok) return { ok: false, code: gate.reason };
  const session: InventoryImportSession = {
    adminTelegramUserId: String(input.actor.numericUserId),
    status: "WAITING_INPUT",
    inputVaultRef: null,
    previewReady: 0,
    previewInvalid: 0,
    previewDuplicates: 0,
    previewVariants: [],
    expiresAt: ttlExpiry(now).getTime(),
  };
  await sql`
    insert into admin_inventory_import
      (admin_telegram_user_id, status, input_vault_ref, preview_ready, preview_invalid,
       preview_duplicates, preview_variants, expires_at, updated_at)
    values (${session.adminTelegramUserId}, ${session.status}, null, 0, 0, 0, '[]'::jsonb,
      ${new Date(session.expiresAt).toISOString()}, now())
    on conflict (admin_telegram_user_id) do update set
      status = excluded.status,
      input_vault_ref = null,
      preview_ready = 0,
      preview_invalid = 0,
      preview_duplicates = 0,
      preview_variants = '[]'::jsonb,
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
): Promise<{ ok: true; cancelled: boolean } | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "NOT_FOUND" }> {
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
  if (session.inputVaultRef) await vault.delete(session.inputVaultRef).catch(() => undefined);
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
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND" | "EXPIRED" }
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
  if (session.expiresAt <= now) {
    if (session.inputVaultRef) await vault.delete(session.inputVaultRef).catch(() => undefined);
    await clearSession(db, String(input.actor.numericUserId));
    return { ok: false, code: "EXPIRED" };
  }
  const preview = await previewDigitalInventory({
    db,
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    input: input.rawInput,
  });
  if (!("ready" in preview)) return preview;
  const rawHash = sha256(input.rawInput);
  const vaultRef = await vault.write(input.rawInput, {
    namespace: "asset",
    idempotencyKey: `inventory-import:${rawHash}`,
  });
  const existingRef = session.inputVaultRef;
  await sql`
    update admin_inventory_import
    set status = 'READY',
        input_vault_ref = ${vaultRef},
        preview_ready = ${preview.ready},
        preview_invalid = ${preview.invalid},
        preview_duplicates = ${preview.duplicates},
        preview_variants = ${JSON.stringify(preview.lines.map((line) => line.variantId).filter((variantId): variantId is string => Boolean(variantId))) }::jsonb,
        expires_at = ${ttlExpiry(now).toISOString()},
        imported_at = null,
        cancelled_at = null,
        updated_at = now()
    where admin_telegram_user_id = ${String(input.actor.numericUserId)}
  `.execute(db);
  if (existingRef && existingRef !== vaultRef) await vault.delete(existingRef).catch(() => undefined);
  return { ok: true, preview };
}

export async function confirmInventoryImportSession(
  db: Db,
  vault: Vault,
  input: InventoryImportSessionInput,
  now = Date.now(),
): Promise<
  | { ok: true; summary: InventoryImportResult; reused: boolean }
  | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND" | "NOT_READY" | "BUSY" | "EXPIRED" }
> {
  const gate = await guardRootAction(db, {
    actor: input.actor,
    config: input.config,
    correlationId: input.correlationId,
    action: "inventory.import",
    targetType: "DigitalAsset",
    targetId: "manual",
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
    if (session.status !== "READY" || !session.inputVaultRef) return { ready: false as const, session };
    await sql`
      update admin_inventory_import
      set status = 'PROCESSING', updated_at = now()
      where admin_telegram_user_id = ${adminTelegramUserId}
    `.execute(trx);
    return { ready: true as const, session };
  });

  if (!prepared) return { ok: false, code: "NOT_FOUND" };
  if ("expired" in prepared) {
    if (prepared.session.inputVaultRef) await vault.delete(prepared.session.inputVaultRef).catch(() => undefined);
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

  const rawInput = await vault.reveal(prepared.session.inputVaultRef);
  try {
    const result = await importDigitalInventory({
      actor: input.actor,
      config: input.config,
      vault,
      db,
      input: rawInput,
      reason: "Admin inventory import",
      correlationId: input.correlationId,
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
    await vault.delete(prepared.session.inputVaultRef).catch(() => undefined);
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
