import { sql } from "kysely";
import type { Db, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../../modules/identity/audit.js";
import {
  isDurableAdminCommandRef,
  type AdminConfirmationService,
  type AtomicExecuteResult,
  type DurableAdminAction,
} from "../../modules/identity/admin-confirmation.js";
import type { IdentityTelemetry } from "../../modules/identity/telemetry.js";
import type { RootActor, RootAdminConfig } from "../../modules/identity/root-admin.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { guardRootAction } from "../middleware/root-admin.js";
import { refundWalletCredit } from "../../modules/wallet/refund.js";
import { completeManualFulfillmentTaskInTransaction } from "../../modules/digital-goods/manual-fulfillment.js";
import {
  clearVariantSupplierMapping,
  markSupplierSkuManuallyVerified,
  selectVariantSupplierMapping,
} from "../../modules/supplier/admin.js";

/**
 * Allowlisted owner callbacks (T097, FR-021–FR-023).
 *
 * The owner surface is a FIXED allowlist of operational verbs — catalog
 * activation/deactivation (kill-switch), discrepancy resolution, and read-only
 * inspection. There is deliberately no identity-granting verb (FR-022). Low-risk
 * verbs execute immediately with an audit; high-risk verbs require an expiring,
 * action-bound confirmation before the effect is applied.
 */

export const OWNER_COMMANDS = [
  "catalog.activate",
  "catalog.deactivate",
  "discrepancy.resolve",
  "discrepancy.list",
  "order.inspect",
  "inventory.import",
  "wallet.refund",
  "manual_fulfillment.complete",
  "supplier.mapping.select",
  "supplier.mapping.clear",
  "supplier.mapping.verify",
  "support.replacement.approve",
] as const;

export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

export function isOwnerCommand(command: string): command is OwnerCommand {
  return (OWNER_COMMANDS as readonly string[]).includes(command);
}
export interface AdminCallbackDeps {
  db: Db;
  rootConfig: RootAdminConfig;
  /** The channel_identity row id for the configured owner (audit + confirmation binding). */
  rootChannelIdentityId: string;
  confirmation: AdminConfirmationService;
  vault?: Vault;
  inventoryImport?: (input: {
    actor: RootActor;
    input: string;
    reason: string;
    correlationId: string;
  }) => Promise<{ imported: number; duplicates: number; invalid: number }>;
  supportReplacementApprove?: (input: {
    exec: Trx;
    caseId: string;
    actorId: string;
    correlationId: string;
  }) => Promise<{ ok: boolean }>;
  telemetry?: IdentityTelemetry;
}

export interface HandleInput {
  command: string;
  actor: RootActor;
  targetId: string;
  reason: string;
  resolutionCode?: string;
  correlationId: string;
  input?: string;
}
export type HandleResult =
  | {
      ok: true;
      needsConfirmation: false;
      inventorySummary?: { imported: number; duplicates: number; invalid: number };
    }
  | {
      ok: true;
      needsConfirmation: true;
      confirmationId: string;
      challenge: string;
      expiresAt: string;
    }
  | {
      ok: false;
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "UNKNOWN_COMMAND"
        | "INVALID_REASON"
        | "NOT_FOUND"
        | "DIGITAL_FILE_ARTIFACT_REQUIRED";
      message: string;
    };

export interface ConfirmActionInput {
  confirmationId: string;
  challenge: string;
  actor: RootActor;
  correlationId: string;
}

export type ConfirmActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "CONFIRM_FAILED" | "NOT_FOUND";
      message: string;
    };

interface PendingAction {
  command: DurableAdminAction["commandRef"];
  targetId: string;
  reason: string;
  resolutionCode?: string;
  actorId: string;
}

class InvalidDurableAdminActionError extends Error {}

export interface AdminCallbacks {
  handle(input: HandleInput): Promise<HandleResult>;
  confirm(input: ConfirmActionInput): Promise<ConfirmActionResult>;
}

function fingerprintFor(command: string, targetId: string, resolutionCode?: string): string {
  return `${command}:${targetId}:${resolutionCode ?? ""}`;
}

function targetTypeFor(
  command: OwnerCommand,
):
  | "ProductVariant"
  | "Discrepancy"
  | "Order"
  | "ManualFulfillmentTask"
  | "SupplierSku"
  | "ReplacementCase" {
  if (command.startsWith("catalog.")) return "ProductVariant";
  if (command.startsWith("supplier.mapping.clear")) return "ProductVariant";
  if (command.startsWith("supplier.")) return "SupplierSku";
  if (command.startsWith("discrepancy.")) return "Discrepancy";
  if (command === "manual_fulfillment.complete") return "ManualFulfillmentTask";
  if (command === "support.replacement.approve") return "ReplacementCase";
  return "Order";
}

function pendingActionFrom(action: DurableAdminAction): PendingAction {
  const payload = action.payloadRedacted;
  const targetId = payload.targetId;
  const reason = payload.reason;
  const actorId = payload.actorId;
  const resolutionCode = payload.resolutionCode;
  if (
    !isDurableAdminCommandRef(action.commandRef) ||
    typeof targetId !== "string" ||
    targetId.length === 0 ||
    targetId.length > 128 ||
    typeof reason !== "string" ||
    reason.trim().length === 0 ||
    reason.length > 500 ||
    typeof actorId !== "string" ||
    !/^\d{1,20}$/.test(actorId) ||
    (resolutionCode !== undefined &&
      (typeof resolutionCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(resolutionCode)))
  ) {
    throw new InvalidDurableAdminActionError("durable admin action payload is invalid");
  }
  const result: PendingAction = {
    command: action.commandRef,
    targetId,
    reason: reason.trim(),
    actorId,
  };
  if (typeof resolutionCode === "string") result.resolutionCode = resolutionCode;
  return result;
}

export function createAdminCallbacks(deps: AdminCallbackDeps): AdminCallbacks {
  const { db, rootConfig, rootChannelIdentityId, confirmation, telemetry } = deps;

  const mapSupplierError = (result: {
    ok: false;
    code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_INPUT" | "NOT_FOUND";
    message: string;
  }): HandleResult => ({
    ok: false,
    code: result.code === "INVALID_INPUT" ? "INVALID_REASON" : result.code,
    message: result.message,
  });
  async function applyLowRisk(input: HandleInput, command: OwnerCommand): Promise<HandleResult> {
    switch (command) {
      case "inventory.import": {
        if (!deps.inventoryImport || input.input === undefined) {
          return { ok: false, code: "INVALID_REASON", message: "Thiếu dữ liệu nhập kho." };
        }
        const summary = await deps.inventoryImport({
          actor: input.actor,
          input: input.input,
          reason: input.reason,
          correlationId: input.correlationId,
        });
        return { ok: true, needsConfirmation: false, inventorySummary: summary };
      }
      case "supplier.mapping.select": {
        if (!input.input)
          return { ok: false, code: "INVALID_REASON", message: "Thiếu SKU nhà cung cấp." };
        const result = await selectVariantSupplierMapping({
          db,
          actor: input.actor,
          config: rootConfig,
          variantId: input.targetId,
          supplierSkuId: input.input,
          reason: input.reason,
          correlationId: input.correlationId,
          ...(telemetry ? { telemetry } : {}),
        });
        return result.ok ? { ok: true, needsConfirmation: false } : mapSupplierError(result);
      }
      case "supplier.mapping.clear": {
        const result = await clearVariantSupplierMapping({
          db,
          actor: input.actor,
          config: rootConfig,
          variantId: input.targetId,
          reason: input.reason,
          correlationId: input.correlationId,
          ...(telemetry ? { telemetry } : {}),
        });
        return result.ok ? { ok: true, needsConfirmation: false } : mapSupplierError(result);
      }
      case "supplier.mapping.verify": {
        if (!input.input)
          return { ok: false, code: "INVALID_REASON", message: "Thiếu SKU nhà cung cấp." };
        const result = await markSupplierSkuManuallyVerified({
          db,
          actor: input.actor,
          config: rootConfig,
          variantId: input.targetId,
          supplierSkuId: input.input,
          reason: input.reason,
          correlationId: input.correlationId,
          ...(telemetry ? { telemetry } : {}),
        });
        return result.ok ? { ok: true, needsConfirmation: false } : mapSupplierError(result);
      }
      case "catalog.activate":
      case "catalog.deactivate": {
        const active = command === "catalog.activate";
        const updated = await withTransaction(db, async (trx) => {
          if (active) {
            const ready = await sql<{ id: string }>`
              select v.id
              from product_variant v
              join variant_file_artifact a on a.variant_id = v.id and a.is_active
              where v.id = ${input.targetId} and v.fulfillment_type = 'DIGITAL_FILE'
              limit 1
            `.execute(trx);
            const digital = await sql<{ id: string }>`
              select id from product_variant where id = ${input.targetId} and fulfillment_type = 'DIGITAL_FILE' limit 1
            `.execute(trx);
            if (digital.rows[0] && !ready.rows[0]) return "DIGITAL_FILE_ARTIFACT_REQUIRED" as const;
          }
          const res = await sql<{ id: string }>`
            update product_variant
            set is_active = ${active}, updated_at = now(), version = version + 1
            where id = ${input.targetId}
            returning id
          `.execute(trx);
          if (res.rows.length === 0) return false;
          await appendAuditEvent(trx, {
            actorType: "ROOT_ADMIN",
            actorId: String(input.actor.numericUserId),
            action: command,
            targetType: "ProductVariant",
            targetId: input.targetId,
            reason: input.reason,
            correlationId: input.correlationId,
            metadataRedacted: { active },
          });
          return true;
        });
        if (updated === "DIGITAL_FILE_ARTIFACT_REQUIRED") {
          return {
            ok: false,
            code: "DIGITAL_FILE_ARTIFACT_REQUIRED",
            message: "Cần nhập và kích hoạt tệp thật trước khi bật bán biến thể tệp số.",
          };
        }
        if (!updated) {
          return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy biến thể." };
        }
        return { ok: true, needsConfirmation: false };
      }
      case "discrepancy.list":
      case "order.inspect": {
        // Read-only inspection is audited but has no mutation.
        await appendAuditEvent(db, {
          actorType: "ROOT_ADMIN",
          actorId: String(input.actor.numericUserId),
          action: command,
          targetType: command === "discrepancy.list" ? "Discrepancy" : "Order",
          targetId: input.targetId,
          reason: input.reason,
          correlationId: input.correlationId,
        });
        return { ok: true, needsConfirmation: false };
      }
      default:
        return { ok: false, code: "UNKNOWN_COMMAND", message: "Lệnh không được hỗ trợ." };
    }
  }

  async function executeHighRisk(
    exec: Trx,
    action: PendingAction,
    correlationId: string,
  ): Promise<boolean> {
    switch (action.command) {
      case "discrepancy.resolve": {
        const res = await sql<{ id: string }>`
          update discrepancy
          set status = 'RESOLVED',
              resolution_code = ${action.resolutionCode ?? "MANUAL_RESOLVE"},
              resolved_at = now()
          where id = ${action.targetId} and status = 'OPEN'
          returning id
        `.execute(exec);
        if (res.rows.length === 0) return false;
        await appendAuditEvent(exec, {
          actorType: "ROOT_ADMIN",
          actorId: action.actorId,
          action: "discrepancy.resolve",
          targetType: "Discrepancy",
          targetId: action.targetId,
          reason: action.reason,
          correlationId,
          metadataRedacted: { resolutionCode: action.resolutionCode ?? "MANUAL_RESOLVE" },
        });
        return true;
      }
      case "wallet.refund": {
        const refunded = await refundWalletCredit(exec, {
          orderId: action.targetId,
          correlationId,
          approvedBy: action.actorId,
        });
        if (!refunded.ok) return false;
        await appendAuditEvent(exec, {
          actorType: "ROOT_ADMIN",
          actorId: action.actorId,
          action: "wallet.refund",
          targetType: "Order",
          targetId: action.targetId,
          reason: action.reason,
          correlationId,
          metadataRedacted: { result: refunded.kind },
        });
        return true;
      }
      case "manual_fulfillment.complete": {
        const completed = await completeManualFulfillmentTaskInTransaction(exec, {
          taskId: action.targetId,
          actorId: action.actorId,
          correlationId,
        });
        return completed.ok;
      }
      case "support.replacement.approve": {
        if (!deps.supportReplacementApprove) return false;
        const approved = await deps.supportReplacementApprove({
          exec,
          caseId: action.targetId,
          actorId: action.actorId,
          correlationId,
        });
        return approved.ok;
      }
      default:
        return false;
    }
  }

  return {
    async handle(input) {
      if (!isOwnerCommand(input.command)) {
        return { ok: false, code: "UNKNOWN_COMMAND", message: "Lệnh không được hỗ trợ." };
      }
      if (
        input.reason.trim().length === 0 ||
        input.reason.length > 500 ||
        input.targetId.length === 0 ||
        input.targetId.length > 128 ||
        (input.resolutionCode !== undefined && !/^[A-Z0-9_]{1,64}$/.test(input.resolutionCode))
      ) {
        return { ok: false, code: "INVALID_REASON", message: "Cần nêu lý do." };
      }

      const gate = await guardRootAction(
        db,
        {
          actor: input.actor,
          config: rootConfig,
          correlationId: input.correlationId,
          action: input.command,
          targetType: targetTypeFor(input.command),
          targetId: input.targetId,
        },
        telemetry,
      );
      if (!gate.ok) {
        return { ok: false, code: gate.reason, message: "Không được phép." };
      }

      if (isDurableAdminCommandRef(input.command)) {
        const fingerprint = fingerprintFor(input.command, input.targetId, input.resolutionCode);
        const payloadRedacted: Record<string, unknown> = {
          targetId: input.targetId,
          reason: input.reason.trim(),
          actorId: String(input.actor.numericUserId),
        };
        if (input.resolutionCode !== undefined) {
          payloadRedacted.resolutionCode = input.resolutionCode;
        }
        const issued = await confirmation.issue({
          rootChannelIdentityId,
          actionFingerprint: fingerprint,
          correlationId: input.correlationId,
          allowlistedCommandRef: input.command,
          payloadRedacted,
        });
        if (!issued.ok) {
          return { ok: false, code: "NOT_FOUND", message: "Không tạo được xác nhận." };
        }
        return {
          ok: true,
          needsConfirmation: true,
          confirmationId: issued.confirmationId,
          challenge: issued.challenge,
          expiresAt: issued.expiresAt,
        };
      }

      return applyLowRisk(input, input.command);
    },

    async confirm(input) {
      const gate = await guardRootAction(
        db,
        {
          actor: input.actor,
          config: rootConfig,
          correlationId: input.correlationId,
          action: "admin.confirm",
          targetType: "AdminConfirmation",
          targetId: input.confirmationId,
        },
        telemetry,
      );
      if (!gate.ok) {
        return { ok: false, code: gate.reason, message: "Không được phép." };
      }

      let executed: AtomicExecuteResult;
      try {
        executed = await confirmation.executeAtomically({
          confirmationId: input.confirmationId,
          rootChannelIdentityId,
          challenge: input.challenge,
          execute: async (trx, durableAction) => {
            const action = pendingActionFrom(durableAction);
            if (
              action.actorId !== String(input.actor.numericUserId) ||
              fingerprintFor(action.command, action.targetId, action.resolutionCode) !==
                durableAction.actionFingerprint
            ) {
              throw new InvalidDurableAdminActionError("durable admin action binding is invalid");
            }
            return executeHighRisk(trx, action, durableAction.correlationId);
          },
        });
      } catch (error) {
        if (error instanceof InvalidDurableAdminActionError) {
          telemetry?.recordFailedConfirmation({
            code: "ACTION_MISMATCH",
            actionFingerprint: input.confirmationId,
          });
          return { ok: false, code: "CONFIRM_FAILED", message: "Xác nhận thất bại." };
        }
        throw error;
      }
      if (!executed.ok) {
        telemetry?.recordFailedConfirmation({
          code: executed.code,
          actionFingerprint: input.confirmationId,
        });
        if (executed.code === "NOT_FOUND" || executed.code === "TARGET_NOT_FOUND") {
          return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy mục cần xử lý." };
        }
        return { ok: false, code: "CONFIRM_FAILED", message: "Xác nhận thất bại." };
      }

      if (!executed.alreadyConsumed) {
        const action = pendingActionFrom(executed.action);
        telemetry?.recordHighRiskAction({ action: action.command, targetId: action.targetId });
      }
      return { ok: true };
    },
  };
}
