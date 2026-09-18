import { createHash } from "node:crypto";
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
import type { AuthorizationJsonValue } from "../../modules/identity/authorization-payload.js";
import {
  authorizeSensitiveAdminAction,
  isSensitiveActionKey,
  type SensitiveActionDeps,
  type SensitiveActionKey,
  type SensitiveAuthorizationRefusal,
} from "../../modules/identity/sensitive-action.js";
import { SENSITIVE_REFUSAL_TEXT } from "../presenters/admin.js";
import { guardRootAction } from "../middleware/root-admin.js";
import { refundWalletCredit } from "../../modules/wallet/refund.js";
import { completeManualFulfillmentTaskInTransaction } from "../../modules/digital-goods/manual-fulfillment.js";
import {
  clearVariantSupplierMapping,
  markSupplierSkuManuallyVerified,
  selectVariantSupplierMapping,
} from "../../modules/supplier/admin.js";
import {
  dispositionDiscrepancyInTransaction,
  isDiscrepancyResolutionCode,
  type DiscrepancyResolutionCode,
} from "../../modules/admin/payment-ops.js";
import {
  dispositionTerminalOutboxEventInTransaction,
  isOutboxDispositionCode,
  type OutboxDispositionCode,
} from "../../infrastructure/outbox/disposition.js";
import {
  isSafeResaleEvidenceInput,
  publishProductInTransaction,
  registerResaleEvidenceInTransaction,
  RESALE_EVIDENCE_SOURCES,
  revokeResaleEvidenceInTransaction,
  type ResaleEvidenceSource,
} from "../../modules/catalog/publication.js";
import { isId } from "../../shared/ids/index.js";
import {
  getStoreOpenReadiness,
  isStoreOpenReady,
  transitionStoreModeInTransaction,
} from "../../modules/commerce/store-mode.js";

/**
 * Allowlisted owner callbacks (T097, FR-021–FR-023).
 *
 * The owner surface is a FIXED allowlist of operational verbs — catalog
 * kill-switch/publication, resale-evidence registration, discrepancy/outbox
 * disposition, store transitions, and read-only inspection. There is deliberately
 * no identity-granting verb (FR-022). Low-risk verbs execute immediately with an
 * audit; high-risk verbs require an expiring, action-bound confirmation before
 * the effect is applied.
 */

export const OWNER_COMMANDS = [
  "catalog.activate",
  "catalog.deactivate",
  "catalog.evidence.register",
  "catalog.evidence.revoke",
  "catalog.publish",
  "discrepancy.resolve",
  "outbox.orphan.dispose",
  "discrepancy.list",
  "order.inspect",
  "inventory.import",
  "wallet.refund",
  "manual_fulfillment.complete",
  "supplier.mapping.select",
  "supplier.mapping.clear",
  "supplier.mapping.verify",
  "support.replacement.approve",
  "store.open",
  "store.close",
  "store.test",
] as const;

export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

export function isOwnerCommand(command: string): command is OwnerCommand {
  return (OWNER_COMMANDS as readonly string[]).includes(command);
}
const SENSITIVE_OPERATOR_TEXT =
  /(secret|token|password|passwd|credential|vault|private\s+key|api\s*key|otp|seed|cookie|session|mật khẩu|khóa\s+(?:api|bí mật))/iu;
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
  /**
   * Resolved step-up policy. `false` disables only the TOTP factor; root identity,
   * durable confirmation, binding and audit remain active.
   */
  stepUpEnabled?: boolean;
  /** TOTP grant TTL, lockout window and attempt budget; env defaults when omitted. */
  stepUpOptions?: { ttlSeconds: number; lockoutMinutes: number; maxAttempts: number };
}

export interface HandleInput {
  command: string;
  actor: RootActor;
  targetId: string;
  reason: string;
  resolutionCode?: string;
  correlationId: string;
  input?: string;
  /** Snapshot version supplied by the operator; publication uses its composite string. */
  expectedVersion?: number | string;
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
        | "DIGITAL_FILE_ARTIFACT_REQUIRED"
        | SensitiveAuthorizationRefusal;
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
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "CONFIRM_FAILED"
        | "NOT_FOUND"
        | "NOT_READY"
        | "ACTION_REFUSED"
        | SensitiveAuthorizationRefusal;
      message: string;
      action?: OwnerCommand;
    };

interface PendingAction {
  command: DurableAdminAction["commandRef"];
  targetId: string;
  reason: string;
  resolutionCode?: string;
  actorId: string;
  input?: string;
  expectedVersion?: number | string;
}

class InvalidDurableAdminActionError extends Error {}

/** Carries a refused step-up through the atomic confirmation boundary without applying a mutation. */
class SensitiveAuthorizationRefusedError extends Error {
  readonly code: SensitiveAuthorizationRefusal;
  readonly action: OwnerCommand;

  constructor(action: OwnerCommand, code: SensitiveAuthorizationRefusal) {
    super(`sensitive admin action refused: ${code}`);
    this.action = action;
    this.code = code;
  }
}

/** Carries a safe, durable action refusal back to the owner callback. */
class DurableAdminActionRefusedError extends Error {
  readonly code: "NOT_READY" | "ACTION_REFUSED";
  readonly action: OwnerCommand;

  constructor(
    action: OwnerCommand,
    message: string,
    code: "NOT_READY" | "ACTION_REFUSED" = "ACTION_REFUSED",
  ) {
    super(message);
    this.action = action;
    this.code = code;
  }
}

function durableResultOrThrow(
  action: PendingAction,
  result: { ok: boolean; code?: string; message?: string },
): boolean {
  if (result.ok) return true;
  const code = result.code === "NOT_READY" ? "NOT_READY" : "ACTION_REFUSED";
  throw new DurableAdminActionRefusedError(
    action.command,
    result.message ?? "Lệnh quản trị không được áp dụng.",
    code,
  );
}

function storeOpenRefusalMessage(
  readiness: Awaited<ReturnType<typeof getStoreOpenReadiness>>,
): string {
  const blockers = [
    ...(readiness.activeProducts === 0 ? ["chưa có sản phẩm public đang hoạt động"] : []),
    ...(readiness.inStockVariants === 0 ? ["chưa có biến thể còn hàng"] : []),
    ...(readiness.openDiscrepancies > 0 ? [`còn ${readiness.openDiscrepancies} sai lệch`] : []),
    ...(readiness.terminalOutboxOrphans > 0
      ? [`còn ${readiness.terminalOutboxOrphans} outbox terminal`]
      : []),
    ...(readiness.criticalSupportTickets > 0
      ? [`còn ${readiness.criticalSupportTickets} ticket MANUAL_REVIEW`]
      : []),
  ];
  return `❌ Chưa thể mở bán: ${blockers.join("; ") || "readiness đã thay đổi"}. Mở lại Store control sau khi xử lý.`;
}

export interface AdminCallbacks {
  handle(input: HandleInput): Promise<HandleResult>;
  confirm(input: ConfirmActionInput): Promise<ConfirmActionResult>;
}

function fingerprintFor(
  command: string,
  targetId: string,
  resolutionCode?: string,
  expectedVersion?: number | string,
  input?: string,
): string {
  const inputHash =
    input === undefined ? "" : createHash("sha256").update(input, "utf8").digest("hex");
  return `${command}:${targetId}:${resolutionCode ?? ""}:${expectedVersion ?? ""}:${inputHash}`;
}

function targetTypeFor(
  command: OwnerCommand,
):
  | "ProductVariant"
  | "Product"
  | "Discrepancy"
  | "OutboxEvent"
  | "Order"
  | "ManualFulfillmentTask"
  | "SupplierSku"
  | "ReplacementCase"
  | "StoreControl" {
  if (command.startsWith("store.")) return "StoreControl";
  if (command === "catalog.publish") return "Product";
  if (command === "catalog.evidence.register") return "ProductVariant";
  if (command.startsWith("catalog.")) return "ProductVariant";
  if (command === "outbox.orphan.dispose") return "OutboxEvent";
  if (command.startsWith("supplier.mapping.clear")) return "ProductVariant";
  if (command.startsWith("supplier.")) return "SupplierSku";
  if (command.startsWith("discrepancy.")) return "Discrepancy";
  if (command === "manual_fulfillment.complete") return "ManualFulfillmentTask";
  if (command === "support.replacement.approve") return "ReplacementCase";
  return "Order";
}

function sensitiveResourceId(input: HandleInput): string {
  return input.command === "supplier.mapping.select" || input.command === "supplier.mapping.verify"
    ? (input.input ?? input.targetId)
    : input.targetId;
}

function sensitiveRequestedData(input: {
  command: string;
  targetId: string;
  value: string | undefined;
  resolutionCode: string | undefined;
  expectedVersion: number | string | undefined;
}): AuthorizationJsonValue {
  if (input.command === "supplier.mapping.select" || input.command === "supplier.mapping.verify") {
    return {
      variantId: input.targetId,
      supplierSkuId: input.value ?? input.targetId,
    };
  }
  return {
    targetId: input.targetId,
    ...(input.resolutionCode === undefined ? {} : { resolutionCode: input.resolutionCode }),
    ...(input.expectedVersion === undefined
      ? {}
      : { expectedVersion: String(input.expectedVersion) }),
    ...(input.command === "catalog.evidence.register" && input.value !== undefined
      ? { evidenceInput: input.value }
      : {}),
    // The revocation names the evidence row it withdraws, and the binding layer reads that
    // row's lifecycle as part of the grant's state, so the id must travel as requested data.
    ...(input.command === "catalog.evidence.revoke" && input.value !== undefined
      ? { evidenceId: input.value }
      : {}),
  };
}

function pendingActionFrom(action: DurableAdminAction): PendingAction {
  const payload = action.payloadRedacted;
  const targetId = payload.targetId;
  const reason = payload.reason;
  const actorId = payload.actorId;
  const resolutionCode = payload.resolutionCode;
  const input = payload.input;
  const expectedVersion = payload.expectedVersion;
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
      (typeof resolutionCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(resolutionCode))) ||
    (input !== undefined &&
      (typeof input !== "string" || input.length === 0 || input.length > 2_000)) ||
    (expectedVersion !== undefined &&
      ((typeof expectedVersion !== "number" && typeof expectedVersion !== "string") ||
        (typeof expectedVersion === "number" && !Number.isInteger(expectedVersion)) ||
        (typeof expectedVersion === "string" &&
          (expectedVersion.length === 0 || expectedVersion.length > 300))))
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
  if (typeof input === "string") result.input = input;
  if (typeof expectedVersion === "number" || typeof expectedVersion === "string") {
    result.expectedVersion = expectedVersion;
  }
  return result;
}

export function createAdminCallbacks(deps: AdminCallbackDeps): AdminCallbacks {
  const { db, rootConfig, rootChannelIdentityId, confirmation, telemetry } = deps;

  // Composed once: every sensitive verb below asks this one layer to authorise.
  const sensitiveDeps: SensitiveActionDeps = {
    db,
    rootConfig,
    vault: deps.vault,
    stepUpEnabled: deps.stepUpEnabled === true,
    // env.ts defaults, used only when a caller omits them (development/tests,
    // where step-up is off).
    stepUpOptions: deps.stepUpOptions ?? { ttlSeconds: 300, lockoutMinutes: 15, maxAttempts: 5 },
    ...(telemetry ? { telemetry } : {}),
  };

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
    requestId: string,
  ): Promise<boolean> {
    switch (action.command) {
      case "discrepancy.resolve": {
        if (
          typeof action.expectedVersion !== "number" ||
          !isDiscrepancyResolutionCode(action.resolutionCode ?? "")
        ) {
          return false;
        }
        const result = await dispositionDiscrepancyInTransaction(exec, {
          discrepancyId: action.targetId,
          expectedVersion: action.expectedVersion,
          resolutionCode: action.resolutionCode as DiscrepancyResolutionCode,
          note: action.reason,
          requestId,
          actorId: action.actorId,
          correlationId,
        });
        return durableResultOrThrow(action, result);
      }
      case "outbox.orphan.dispose": {
        if (
          typeof action.expectedVersion !== "number" ||
          !isOutboxDispositionCode(action.resolutionCode ?? "")
        ) {
          return false;
        }
        const result = await dispositionTerminalOutboxEventInTransaction(exec, {
          eventId: action.targetId,
          expectedVersion: action.expectedVersion,
          code: action.resolutionCode as OutboxDispositionCode,
          note: action.reason,
          requestId,
          actorId: action.actorId,
          correlationId,
        });
        return durableResultOrThrow(action, result);
      }
      case "wallet.refund": {
        const refunded = await refundWalletCredit(exec, {
          orderId: action.targetId,
          correlationId,
          approvedBy: action.actorId,
        });
        if (!refunded.ok) {
          throw new DurableAdminActionRefusedError(action.command, refunded.message);
        }
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
        return durableResultOrThrow(action, completed);
      }
      case "support.replacement.approve": {
        if (!deps.supportReplacementApprove) return false;
        const approved = await deps.supportReplacementApprove({
          exec,
          caseId: action.targetId,
          actorId: action.actorId,
          correlationId,
        });
        if (!approved.ok) {
          throw new DurableAdminActionRefusedError(
            action.command,
            "Yêu cầu thay thế chưa được áp dụng.",
          );
        }
        return true;
      }
      case "store.open":
      case "store.close":
      case "store.test": {
        if (typeof action.expectedVersion !== "number") return false;
        if (action.command === "store.open") {
          // Re-read inside the executing transaction with the same predicate the durable
          // transition uses: the preview may be stale, and a parked queue still blocks.
          const readiness = await getStoreOpenReadiness(exec);
          if (!isStoreOpenReady(readiness)) {
            throw new DurableAdminActionRefusedError(
              action.command,
              storeOpenRefusalMessage(readiness),
              "NOT_READY",
            );
          }
        }
        const targetMode =
          action.command === "store.open"
            ? "OPEN"
            : action.command === "store.close"
              ? "CLOSED"
              : "TEST";
        const result = await transitionStoreModeInTransaction(exec, {
          targetMode,
          expectedVersion: action.expectedVersion,
          requestId,
          actorId: action.actorId,
          reason: action.reason,
          correlationId,
        });
        return durableResultOrThrow(action, result);
      }
      case "catalog.evidence.register": {
        if (!action.input) return false;
        const fields = action.input.split("|");
        if (fields.length !== 3) return false;
        const source = fields[0]?.trim();
        const reference = fields[1]?.trim();
        const summary = fields[2]?.trim();
        if (
          !source ||
          !reference ||
          !summary ||
          !(RESALE_EVIDENCE_SOURCES as readonly string[]).includes(source)
        ) {
          return false;
        }
        const result = await registerResaleEvidenceInTransaction(exec, {
          variantId: action.targetId,
          source: source as ResaleEvidenceSource,
          reference,
          summary,
          requestId,
          actorId: action.actorId,
          reason: action.reason,
          correlationId,
        });
        return durableResultOrThrow(action, result);
      }
      case "catalog.evidence.revoke": {
        if (typeof action.expectedVersion !== "number" || !action.input || !isId(action.input)) {
          return false;
        }
        // The confirmation id IS the request id, exactly as registration does it: the
        // message correlation id stays audit-only, and a retried request for the same
        // evidence is a domain-level replay instead of a second revocation.
        const result = await revokeResaleEvidenceInTransaction(exec, {
          evidenceId: action.input,
          variantId: action.targetId,
          expectedVariantVersion: action.expectedVersion,
          requestId,
          actorId: action.actorId,
          reason: action.reason,
          correlationId,
        });
        return durableResultOrThrow(action, result);
      }
      case "catalog.publish": {
        if (typeof action.expectedVersion !== "string") return false;
        const result = await publishProductInTransaction(exec, {
          productId: action.targetId,
          expectedPublicationVersion: action.expectedVersion,
          actorId: action.actorId,
          reason: action.reason,
          correlationId,
        });
        return durableResultOrThrow(action, result);
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
      if (
        input.reason.trim().length === 0 ||
        input.reason.length > 500 ||
        input.targetId.length === 0 ||
        input.targetId.length > 128 ||
        (input.input !== undefined && (input.input.length === 0 || input.input.length > 2_000)) ||
        (input.resolutionCode !== undefined && !/^[A-Z0-9_]{1,64}$/.test(input.resolutionCode)) ||
        (input.expectedVersion !== undefined &&
          ((typeof input.expectedVersion === "number" &&
            !Number.isInteger(input.expectedVersion)) ||
            (typeof input.expectedVersion === "string" &&
              (input.expectedVersion.length === 0 || input.expectedVersion.length > 300))))
      ) {
        return { ok: false, code: "INVALID_REASON", message: "Cần nêu lý do." };
      }
      const revokeInputInvalid =
        input.command === "catalog.evidence.revoke" &&
        // A revocation must name one existing evidence row and the variant version the
        // owner saw. Both are opaque, so nothing an operator typed can smuggle facts in.
        (input.input === undefined ||
          !isId(input.input) ||
          typeof input.expectedVersion !== "number" ||
          !Number.isInteger(input.expectedVersion) ||
          input.expectedVersion <= 0);
      if (
        SENSITIVE_OPERATOR_TEXT.test(input.reason) ||
        (input.command !== "inventory.import" &&
          input.input !== undefined &&
          SENSITIVE_OPERATOR_TEXT.test(input.input)) ||
        (input.command === "catalog.evidence.register" &&
          (input.input === undefined || !isSafeResaleEvidenceInput(input.input))) ||
        revokeInputInvalid
      ) {
        return {
          ok: false,
          code: "INVALID_REASON",
          message: revokeInputInvalid
            ? "Thiếu bằng chứng hoặc phiên bản biến thể cần thu hồi."
            : "Không lưu dữ liệu nhạy cảm trong xác nhận quản trị.",
        };
      }

      const actionKey: SensitiveActionKey | null = isDurableAdminCommandRef(input.command)
        ? input.command
        : isSensitiveActionKey(input.command)
          ? input.command
          : null;
      if (actionKey !== null) {
        // Before ANY mutation, and before a confirmation is even issued. A durable
        // command only PREVIEWS the grant (consumeGrant: false) so confirm() can
        // still spend it; an immediate verb spends it right here, because here is
        // where it mutates.
        const authorization = await authorizeSensitiveAdminAction(sensitiveDeps, {
          actor: input.actor,
          actionKey,
          resourceType: targetTypeFor(input.command),
          resourceId: sensitiveResourceId(input),
          correlationId: input.correlationId,
          requestedData: sensitiveRequestedData({
            command: input.command,
            targetId: input.targetId,
            value: input.input,
            resolutionCode: input.resolutionCode,
            expectedVersion: input.expectedVersion,
          }),
          consumeGrant: !isDurableAdminCommandRef(input.command),
        });
        if (!authorization.ok) {
          return {
            ok: false,
            code: authorization.code,
            message: SENSITIVE_REFUSAL_TEXT[authorization.code],
          };
        }
      }

      if (isDurableAdminCommandRef(input.command)) {
        const fingerprint = fingerprintFor(
          input.command,
          input.targetId,
          input.resolutionCode,
          input.expectedVersion,
          input.input,
        );
        const payloadRedacted: Record<string, unknown> = {
          targetId: input.targetId,
          reason: input.reason.trim(),
          actorId: String(input.actor.numericUserId),
        };
        if (input.resolutionCode !== undefined) {
          payloadRedacted.resolutionCode = input.resolutionCode;
        }
        if (input.input !== undefined) {
          payloadRedacted.input = input.input;
        }
        if (input.expectedVersion !== undefined) {
          payloadRedacted.expectedVersion = input.expectedVersion;
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
              fingerprintFor(
                action.command,
                action.targetId,
                action.resolutionCode,
                action.expectedVersion,
                action.input,
              ) !== durableAction.actionFingerprint
            ) {
              throw new InvalidDurableAdminActionError("durable admin action binding is invalid");
            }
            // The grant is spent inside the atomic confirmation, immediately
            // before the mutation, so a refused step-up can never reach
            // `executeHighRisk` and a replayed confirmation cannot spend twice.
            //
            // Semantics when the mutation itself then fails: the step-up service
            // owns its own transaction, so the grant stays consumed while this
            // one rolls back — consumed-but-not-mutated. That is the fail-closed
            // direction (the admin re-verifies and retries); the reverse, a
            // mutation with an unspent grant, is impossible because this call is
            // a precondition of the mutation.
            const authorization = await authorizeSensitiveAdminAction(sensitiveDeps, {
              actor: input.actor,
              actionKey: action.command,
              resourceType: targetTypeFor(action.command),
              resourceId: action.targetId,
              correlationId: durableAction.correlationId,
              requestedData: sensitiveRequestedData({
                command: action.command,
                targetId: action.targetId,
                value: action.input,
                resolutionCode: action.resolutionCode,
                expectedVersion: action.expectedVersion,
              }),
              consumeGrant: true,
            });
            if (!authorization.ok) {
              throw new SensitiveAuthorizationRefusedError(action.command, authorization.code);
            }
            return executeHighRisk(trx, action, durableAction.correlationId, input.confirmationId);
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
        if (error instanceof SensitiveAuthorizationRefusedError) {
          return {
            ok: false,
            code: error.code,
            message: SENSITIVE_REFUSAL_TEXT[error.code],
            action: error.action,
          };
        }
        if (error instanceof DurableAdminActionRefusedError) {
          telemetry?.recordFailedConfirmation({
            code: error.code,
            actionFingerprint: input.confirmationId,
          });
          return { ok: false, code: error.code, message: error.message, action: error.action };
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
