import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import type { RootActor, RootAdminConfig } from "../identity/root-admin.js";
import { guardRootAction } from "../../bot/middleware/root-admin.js";
import type { IdentityTelemetry } from "../identity/telemetry.js";

export interface AdminSupplierActionInput {
  db: Db;
  actor: RootActor;
  config: RootAdminConfig;
  variantId: string;
  reason: string;
  correlationId: string;
  telemetry?: IdentityTelemetry;
}

export interface SelectSupplierMappingInput extends AdminSupplierActionInput {
  supplierSkuId: string;
}

export type AdminSupplierActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND";
      message: string;
    };

function invalid(message: string): AdminSupplierActionResult {
  return { ok: false, code: "INVALID_INPUT", message };
}

function isId(value: string): boolean {
  return value.length > 0 && value.length <= 128;
}

function validReason(reason: string): boolean {
  return reason.trim().length > 0 && reason.length <= 500;
}

async function authorize(
  input: AdminSupplierActionInput,
  action: string,
  targetId: string,
  targetType: "ProductVariant" | "SupplierSku",
): Promise<AdminSupplierActionResult | null> {
  if (!isId(input.variantId) || !isId(targetId))
    return invalid("Mã biến thể hoặc SKU nhà cung cấp không hợp lệ.");
  if (!validReason(input.reason)) return invalid("Cần nêu lý do.");
  const gate = await guardRootAction(
    input.db,
    {
      actor: input.actor,
      config: input.config,
      correlationId: input.correlationId,
      action,
      targetType,
      targetId,
    },
    input.telemetry,
  );
  return gate.ok ? null : { ok: false, code: gate.reason, message: "Không được phép." };
}

export async function selectVariantSupplierMapping(
  input: SelectSupplierMappingInput,
): Promise<AdminSupplierActionResult> {
  const denied = await authorize(
    input,
    "supplier.mapping.select",
    input.supplierSkuId,
    "SupplierSku",
  );
  if (denied) return denied;

  return withTransaction(input.db, async (trx) => {
    const variant = await sql<{ id: string }>`
      select id
      from product_variant
      where id = ${input.variantId}
      for update
    `.execute(trx);
    if (!variant.rows[0])
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: "Không tìm thấy biến thể.",
      };

    const candidate = await sql<{ supplier_id: string }>`
      select ss.supplier_id
      from supplier_sku ss
      join supplier s on s.id = ss.supplier_id
      where ss.id = ${input.supplierSkuId}
        and ss.variant_id = ${input.variantId}
        and ss.is_active
        and s.status = 'ACTIVE'
      limit 1
      for update of ss
    `.execute(trx);
    if (!candidate.rows[0])
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: "Không tìm thấy SKU nhà cung cấp đang hoạt động cho biến thể.",
      };

    await sql`
      update product_variant
      set supplier_sku_id = ${input.supplierSkuId},
          updated_at = now(),
          version = version + 1
      where id = ${input.variantId}
    `.execute(trx);

    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "supplier.mapping.select",
      targetType: "SupplierSku",
      targetId: input.supplierSkuId,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: { variantId: input.variantId, supplierId: candidate.rows[0].supplier_id },
    });
    return { ok: true as const };
  });
}

export async function clearVariantSupplierMapping(
  input: AdminSupplierActionInput,
): Promise<AdminSupplierActionResult> {
  const denied = await authorize(
    input,
    "supplier.mapping.clear",
    input.variantId,
    "ProductVariant",
  );
  if (denied) return denied;
  return withTransaction(input.db, async (trx) => {
    const variant = await sql<{ supplier_sku_id: string | null }>`
      select supplier_sku_id
      from product_variant
      where id = ${input.variantId}
      for update
    `.execute(trx);
    const row = variant.rows[0];
    if (!row)
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: "Không tìm thấy biến thể.",
      };
    await sql`
      update product_variant
      set supplier_sku_id = null,
          updated_at = now(),
          version = version + 1
      where id = ${input.variantId}
    `.execute(trx);

    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "supplier.mapping.clear",
      targetType: "ProductVariant",
      targetId: input.variantId,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: { previousSupplierSkuId: row.supplier_sku_id },
    });
    return { ok: true as const };
  });
}

export async function markSupplierSkuManuallyVerified(
  input: SelectSupplierMappingInput,
): Promise<AdminSupplierActionResult> {
  const denied = await authorize(
    input,
    "supplier.mapping.verify",
    input.supplierSkuId,
    "SupplierSku",
  );
  if (denied) return denied;

  return withTransaction(input.db, async (trx) => {
    const updated = await sql<{ supplier_id: string }>`
      update supplier_sku ss
      set last_verified_at = now(), version = ss.version + 1
      from supplier s
      where ss.id = ${input.supplierSkuId}
        and ss.variant_id = ${input.variantId}
        and s.id = ss.supplier_id
        and ss.is_active
        and s.status = 'ACTIVE'
      returning ss.supplier_id
    `.execute(trx);
    if (!updated.rows[0])
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: "Không tìm thấy SKU nhà cung cấp đang hoạt động cho biến thể.",
      };

    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: "supplier.mapping.verify",
      targetType: "SupplierSku",
      targetId: input.supplierSkuId,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: { variantId: input.variantId, supplierId: updated.rows[0].supplier_id },
    });
    return { ok: true as const };
  });
}
