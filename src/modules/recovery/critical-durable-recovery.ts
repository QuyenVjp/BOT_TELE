import { sql } from "kysely";
import type { Db, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import { requiresQueryBeforeRetry, type SupplierOrderStatus } from "../supplier/domain.js";

export type CriticalRecoveryFamily =
  | "outbox"
  | "notification_delivery"
  | "delivery_notification_handoff"
  | "telegram_inbox"
  | "sepay_inbox"
  | "supplier_order";

export type CriticalRecoveryResult =
  | { ok: true; family: CriticalRecoveryFamily; id: string; recovered: true }
  | {
      ok: false;
      family: CriticalRecoveryFamily;
      id: string;
      code:
        | "NOT_FOUND"
        | "NOT_TERMINAL"
        | "ACTIVE_LEASE"
        | "UNSUPPORTED_JOB_FAMILY"
        | "MANUAL_REVIEW_REQUIRED"
        | "NOT_ROOT_ADMIN"
        | "STALE";
      message: string;
    };

export interface CriticalRecoveryInput {
  family: CriticalRecoveryFamily;
  id: string;
  rootAdminTelegramUserId: string;
  reason: string;
  correlationId: string;
  configuredRootAdminTelegramUserId: string;
}

const RETRY_SAFE_OUTBOX_EVENTS: Record<string, true> = {
  DigitalAssetClaimed: true,
  DigitalAssetDelivered: true,
  ManualFulfillmentTaskCompleted: true,
  ManualFulfillmentTaskCreated: true,
  StockDelta: true,
  WalletRefunded: true,
  WalletTopupCredited: true,
  WalletTopupPresented: true,
};

const AMBIGUOUS_DELIVERY_HANDOFF_ERRORS: Record<string, true> = {
  DeliveryNotificationSendTimeoutError: true,
  TelegramAmbiguousSendError: true,
};

function fail(
  input: CriticalRecoveryInput,
  code: Exclude<CriticalRecoveryResult, { ok: true }>["code"],
  message: string,
): Exclude<CriticalRecoveryResult, { ok: true }> {
  return { ok: false, family: input.family, id: input.id, code, message };
}

class StaleRecoveryConflict extends Error {
  constructor(readonly result: Exclude<CriticalRecoveryResult, { ok: true }>) {
    super(result.message);
  }
}

function stale(input: CriticalRecoveryInput, message: string): never {
  throw new StaleRecoveryConflict(fail(input, "STALE", message));
}

function validateInput(input: CriticalRecoveryInput): void {
  if (!/^[1-9][0-9]{0,19}$/.test(input.rootAdminTelegramUserId)) {
    throw new Error("rootAdminTelegramUserId must be numeric");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(input.configuredRootAdminTelegramUserId)) {
    throw new Error("configuredRootAdminTelegramUserId must be numeric");
  }
  if (input.reason.trim().length === 0) throw new Error("reason is required");
  if (input.reason.length > 500) throw new Error("reason is too long");
  if (input.correlationId.trim().length === 0 || input.correlationId.length > 128) {
    throw new Error("correlationId is required");
  }
}

function hasActiveLease(row: {
  claimed_by: string | null;
  claim_expires_at: Date | string | null;
}): boolean {
  return (
    !!row.claimed_by &&
    !!row.claim_expires_at &&
    new Date(row.claim_expires_at).getTime() > Date.now()
  );
}

async function audit(
  trx: Trx,
  input: CriticalRecoveryInput,
  beforeState: string,
  afterState: string,
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: "ROOT_ADMIN",
    actorId: input.rootAdminTelegramUserId,
    action: "critical_recovery.retry",
    targetType: input.family,
    targetId: input.id,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      family: input.family,
      jobType: input.family,
      beforeState,
      afterState,
      rootAdminTelegramUserId: input.rootAdminTelegramUserId,
    },
  });
}

async function recoverOutbox(
  trx: Trx,
  input: CriticalRecoveryInput,
): Promise<CriticalRecoveryResult> {
  const row = (
    await sql<{
      id: string;
      event_type: string;
      aggregate_id: string;
      dead_lettered_at: Date | string | null;
      published_at: Date | string | null;
      claimed_by: string | null;
      claim_expires_at: Date | string | null;
      claim_generation: string;
    }>`
      select id,event_type,aggregate_id,dead_lettered_at,published_at,claimed_by,claim_expires_at,claim_generation::text
      from outbox_event where id=${input.id} for update
    `.execute(trx)
  ).rows[0];
  if (!row) return fail(input, "NOT_FOUND", "outbox row not found");
  if (row.published_at || !row.dead_lettered_at)
    return fail(input, "NOT_TERMINAL", "outbox row is not dead-lettered");
  if (hasActiveLease(row)) return fail(input, "ACTIVE_LEASE", "outbox row has an active lease");
  if (!(row.event_type === "OrderPaid" || RETRY_SAFE_OUTBOX_EVENTS[row.event_type] === true)) {
    return fail(
      input,
      "UNSUPPORTED_JOB_FAMILY",
      `outbox event ${row.event_type} is not retry-allowlisted`,
    );
  }
  if (row.event_type === "OrderPaid") {
    const ambiguous = await sql<{ id: string }>`
      select id from supplier_order
      where order_id=${row.aggregate_id} and status in ('UNKNOWN','PENDING','SUBMITTED')
      order by submitted_at desc nulls last, id desc
      limit 1
    `.execute(trx);
    const supplierOrder = ambiguous.rows[0];
    if (supplierOrder) {
      const recovered = await recoverSupplierOrder(trx, {
        ...input,
        family: "supplier_order",
        id: supplierOrder.id,
      });
      if (!recovered.ok) return recovered;
      await audit(trx, input, "DEAD_WITH_AMBIGUOUS_SUPPLIER_ORDER", "SUPPLIER_RECONCILE_QUEUED");
      return { ok: true, family: input.family, id: input.id, recovered: true };
    }
  }

  const updated = await sql<{
    id: string;
    claim_generation: string;
    dead_lettered_at: Date | string | null;
  }>`
    update outbox_event
    set dead_lettered_at=null, next_attempt_at=now(), last_error_code=null,
        claimed_by=null, claimed_at=null, claim_expires_at=null,
        claim_generation=claim_generation+1
    where id=${input.id}
      and published_at is null
      and dead_lettered_at is not null
      and claim_generation=${Number(row.claim_generation)}
    returning id, claim_generation::text, dead_lettered_at
  `.execute(trx);
  const recovered = updated.rows[0];
  if (
    updated.rows.length !== 1 ||
    !recovered ||
    recovered.dead_lettered_at !== null ||
    Number(recovered.claim_generation) !== Number(row.claim_generation) + 1
  ) {
    stale(input, "outbox row changed during recovery");
  }
  await audit(trx, input, "DEAD", "RETRY");
  return { ok: true, family: input.family, id: input.id, recovered: true };
}

async function recoverNotificationDelivery(
  trx: Trx,
  input: CriticalRecoveryInput,
): Promise<CriticalRecoveryResult> {
  const row = (
    await sql<{
      id: string;
      status: string;
      last_error: string | null;
      sent_at: Date | string | null;
      claimed_by: string | null;
      claim_expires_at: Date | string | null;
      claim_generation: string;
    }>`
      select id,status,last_error,sent_at,claimed_by,claim_expires_at,claim_generation::text
      from notification_delivery where id=${input.id} for update
    `.execute(trx)
  ).rows[0];
  if (!row) return fail(input, "NOT_FOUND", "notification delivery not found");
  if (row.status !== "DEAD")
    return fail(input, "NOT_TERMINAL", "notification delivery is not DEAD");
  if (hasActiveLease(row))
    return fail(input, "ACTIVE_LEASE", "notification delivery has an active lease");
  if (row.sent_at || row.last_error === "TelegramAmbiguousSendError") {
    return fail(
      input,
      "MANUAL_REVIEW_REQUIRED",
      "notification Telegram send outcome is ambiguous; do not resend",
    );
  }

  const updated = await sql<{ id: string }>`
    update notification_delivery
    set status='RETRY', next_attempt_at=now(), last_error=null,
        claimed_by=null, claim_expires_at=null, claim_generation=claim_generation+1
    where id=${input.id} and status='DEAD' and claim_generation=${Number(row.claim_generation)}
    returning id
  `.execute(trx);
  if (updated.rows.length !== 1)
    return fail(input, "STALE", "notification delivery changed during recovery");
  await audit(trx, input, row.status, "RETRY");
  return { ok: true, family: input.family, id: input.id, recovered: true };
}

async function recoverDeliveryHandoff(
  trx: Trx,
  input: CriticalRecoveryInput,
): Promise<CriticalRecoveryResult> {
  const row = (
    await sql<{
      id: string;
      status: string;
      sent_at: Date | string | null;
      last_error_code: string | null;
      claimed_by: string | null;
      claim_expires_at: Date | string | null;
      claim_generation: string;
    }>`
      select id,status,sent_at,last_error_code,claimed_by,claim_expires_at,claim_generation::text
      from delivery_notification_handoff where id=${input.id} for update
    `.execute(trx)
  ).rows[0];
  if (!row) return fail(input, "NOT_FOUND", "delivery handoff not found");
  if (row.status !== "DEAD") return fail(input, "NOT_TERMINAL", "delivery handoff is not DEAD");
  if (hasActiveLease(row))
    return fail(input, "ACTIVE_LEASE", "delivery handoff has an active lease");
  if (
    row.sent_at ||
    (row.last_error_code && AMBIGUOUS_DELIVERY_HANDOFF_ERRORS[row.last_error_code] === true)
  ) {
    return fail(
      input,
      "MANUAL_REVIEW_REQUIRED",
      "delivery Telegram send outcome is ambiguous; do not resend",
    );
  }

  const updated = await sql<{ id: string }>`
    update delivery_notification_handoff
    set status='RETRY', next_attempt_at=now(), last_error_code=null,
        claimed_by=null, claim_expires_at=null, claim_generation=claim_generation+1
    where id=${input.id} and status='DEAD' and claim_generation=${Number(row.claim_generation)}
    returning id
  `.execute(trx);
  if (updated.rows.length !== 1)
    return fail(input, "STALE", "delivery handoff changed during recovery");
  await audit(trx, input, row.status, "RETRY");
  return { ok: true, family: input.family, id: input.id, recovered: true };
}

async function recoverInbox(
  trx: Trx,
  input: CriticalRecoveryInput,
  source: "telegram" | "sepay",
): Promise<CriticalRecoveryResult> {
  const row = (
    await sql<{
      id: string;
      processing_status: string;
      claimed_by: string | null;
      claim_expires_at: Date | string | null;
      claim_generation: string;
    }>`
      select id,processing_status,claimed_by,claim_expires_at,claim_generation::text
      from webhook_inbox where id=${input.id} and source=${source} for update
    `.execute(trx)
  ).rows[0];
  if (!row) return fail(input, "NOT_FOUND", `${source} inbox row not found`);
  if (row.processing_status !== "DEAD")
    return fail(input, "NOT_TERMINAL", `${source} inbox row is not DEAD`);
  if (hasActiveLease(row))
    return fail(input, "ACTIVE_LEASE", `${source} inbox row has an active lease`);

  const updated = await sql<{ id: string }>`
    update webhook_inbox
    set processing_status='RETRY', next_attempt_at=now(), dead_lettered_at=null,
        last_error_code=null, claimed_by=null, claim_expires_at=null,
        claim_generation=claim_generation+1
    where id=${input.id} and source=${source} and processing_status='DEAD' and claim_generation=${Number(row.claim_generation)}
    returning id
  `.execute(trx);
  if (updated.rows.length !== 1)
    return fail(input, "STALE", `${source} inbox row changed during recovery`);
  await audit(trx, input, row.processing_status, "RETRY");
  return { ok: true, family: input.family, id: input.id, recovered: true };
}

async function recoverSupplierOrder(
  trx: Trx,
  input: CriticalRecoveryInput,
): Promise<CriticalRecoveryResult> {
  const row = (
    await sql<{ id: string; status: SupplierOrderStatus; version: number }>`
      select id,status,version from supplier_order where id=${input.id} for update
    `.execute(trx)
  ).rows[0];
  if (!row) return fail(input, "NOT_FOUND", "supplier order not found");
  if (!requiresQueryBeforeRetry(row.status)) {
    return fail(input, "NOT_TERMINAL", "supplier order is not in a reconciliation state");
  }

  const updated = await sql<{ id: string }>`
    update supplier_order
    set next_reconcile_at=now(), last_queried_at=null, version=version+1
    where id=${input.id} and status in ('UNKNOWN','PENDING','SUBMITTED') and version=${row.version}
    returning id
  `.execute(trx);
  if (updated.rows.length !== 1)
    return fail(input, "STALE", "supplier order changed during recovery");
  await audit(trx, input, row.status, "RECONCILE");
  return { ok: true, family: input.family, id: input.id, recovered: true };
}

export async function recoverCriticalJob(
  db: Db,
  input: CriticalRecoveryInput,
): Promise<CriticalRecoveryResult> {
  validateInput(input);
  if (input.rootAdminTelegramUserId !== input.configuredRootAdminTelegramUserId) {
    return fail(input, "NOT_ROOT_ADMIN", "root admin actor does not match configured root admin");
  }
  try {
    return await withTransaction(db, async (trx) => {
      switch (input.family) {
        case "outbox":
          return recoverOutbox(trx, input);
        case "notification_delivery":
          return recoverNotificationDelivery(trx, input);
        case "delivery_notification_handoff":
          return recoverDeliveryHandoff(trx, input);
        case "telegram_inbox":
          return recoverInbox(trx, input, "telegram");
        case "sepay_inbox":
          return recoverInbox(trx, input, "sepay");
        case "supplier_order":
          return recoverSupplierOrder(trx, input);
        default:
          return fail(
            input,
            "UNSUPPORTED_JOB_FAMILY",
            `job family ${String(input.family)} is not supported`,
          );
      }
    });
  } catch (error) {
    if (error instanceof StaleRecoveryConflict) return error.result;
    throw error;
  }
}
