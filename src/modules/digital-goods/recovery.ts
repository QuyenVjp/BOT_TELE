import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import { releaseReservedAsset } from "./repository.js";
import { appendAuditEvent } from "../identity/audit.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { isId } from "../../shared/ids/index.js";

export type ReadyAssetRecoveryResult =
  { ok: true; assetId: string; newVersion: number } | { ok: false; code: "RECOVERY_NOT_SAFE" };

interface ReadyAssetProof {
  unsafe_order_status: boolean;
  paid_payment_intent: boolean;
  live_payment_intent: boolean;
  settled_allocation: boolean;
  open_discrepancy: boolean;
  delivery_evidence: boolean;
  delivery_handoff: boolean;
  refund_obligation: boolean;
  replacement_obligation: boolean;
  warranty_obligation: boolean;
  manual_fulfillment: boolean;
}

function hasUnsafeReadyAssetProof(proof: ReadyAssetProof): boolean {
  return Object.values(proof).some(Boolean);
}

export async function releaseReadyAssetInTransaction(
  exec: Executor,
  input: {
    assetId: string;
    expectedVersion: number;
    actorId: string;
    reason: string;
    correlationId: string;
    requestId: string;
  },
): Promise<ReadyAssetRecoveryResult> {
  if (
    !isId(input.assetId) ||
    input.expectedVersion < 1 ||
    !Number.isInteger(input.expectedVersion) ||
    !/^[1-9][0-9]{0,19}$/u.test(input.actorId) ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const initial = await sql<{ reserved_order_id: string | null }>`
    select reserved_order_id from digital_asset where id = ${input.assetId}
  `.execute(exec);
  const orderId = initial.rows[0]?.reserved_order_id;
  if (!orderId) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  const order = await sql<{ id: string }>`
    select id from "order" where id = ${orderId} for update
  `.execute(exec);
  if (!order.rows[0]) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  const asset = await sql<{
    id: string;
    version: number;
    status: string;
    reserved_order_id: string | null;
    delivered_order_id: string | null;
  }>`
    select id, version, status, reserved_order_id, delivered_order_id
    from digital_asset where id = ${input.assetId} for update
  `.execute(exec);
  const row = asset.rows[0];
  if (
    !row ||
    row.version !== input.expectedVersion ||
    row.status !== "READY" ||
    row.reserved_order_id !== orderId ||
    row.delivered_order_id !== null
  ) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const proof = await sql<ReadyAssetProof>`
    select
      (o.status not in ('DRAFT','PENDING_PAYMENT','CANCELLED','EXPIRED','REJECTED')) as unsafe_order_status,
      exists (
        select 1 from payment_intent
        where order_id = o.id and status in ('SUCCEEDED','NEEDS_REVIEW')
      ) as paid_payment_intent,
      exists (
        select 1 from payment_intent
        where order_id = o.id and status in ('CREATED','PRESENTED')
      ) as live_payment_intent,
      exists (
        select 1 from payment_allocation a
        join payment_intent i on i.id = a.payment_intent_id
        where i.order_id = o.id and a.status = 'SETTLED'
      ) as settled_allocation,
      exists (select 1 from discrepancy where order_id = o.id and status = 'OPEN') as open_discrepancy,
      exists (
        select 1 from delivery_bundle
        where order_id = o.id and status in ('CREATED','AVAILABLE','VIEWED','CONSUMED')
      ) as delivery_evidence,
      exists (
        select 1 from delivery_notification_handoff h
        join delivery_bundle b on b.id = h.bundle_id
        where b.order_id = o.id
      ) as delivery_handoff,
      (
        exists (
          select 1 from shop_refund_obligation r
          where r.order_id = o.id and r.status = 'OPEN'
        )
        or exists (
          select 1 from warranty_claim c
          left join shop_refund_obligation r on r.id = c.refund_obligation_id
          where c.order_id = o.id
            and (
              c.status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID')
              or r.status = 'OPEN'
            )
        )
      ) as refund_obligation,
      exists (
        select 1 from replacement_case
        where order_id = o.id and status not in ('REJECTED','CLOSED')
      ) as replacement_obligation,
      exists (
        select 1 from warranty_claim
        where order_id = o.id and status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID')
      ) as warranty_obligation,
      exists (
        select 1 from manual_fulfillment_task
        where order_id = o.id and status = 'OPEN'
      ) as manual_fulfillment
    from "order" o where o.id = ${orderId}
  `.execute(exec);
  if (!proof.rows[0] || hasUnsafeReadyAssetProof(proof.rows[0])) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const newVersion = nextVersion(input.expectedVersion);
  const updated = await sql<{ version: number }>`
    update digital_asset
    set status = 'AVAILABLE', reserved_order_id = null, reserved_until = null,
        version = ${newVersion}, updated_at = now()
    where id = ${input.assetId} and status = 'READY' and version = ${input.expectedVersion}
      and reserved_order_id = ${orderId} and delivered_order_id is null
    returning version
  `.execute(exec);
  if (!updated.rows[0]) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "digital_asset.ready_released",
    targetType: "DigitalAsset",
    targetId: input.assetId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      orderId,
      previousStatus: "READY",
      status: "AVAILABLE",
      previousVersion: input.expectedVersion,
      version: newVersion,
    },
  });
  return { ok: true, assetId: input.assetId, newVersion };
}

export async function recoverStaleReservationsBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string; version: number }>`
          select id, version from digital_asset
          where status = 'RESERVED'
            and reserved_until is not null
            and reserved_until < ${now.toISOString()}
            ${excludedFilter}
          order by reserved_until asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        const selected = candidate.rows[0];
        selectedId = selected?.id ?? null;
        if (!selected) return false;
        return releaseReservedAsset(trx, selected.id, selected.version);
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null)
        throw new Error("reservation recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(reserved_until) as oldest
    from digital_asset
    where status = 'RESERVED'
      and reserved_until is not null
      and reserved_until < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}

export async function recoverExpiredDeliveryBundlesBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string }>`
          select id from delivery_bundle
          where status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
            ${excludedFilter}
          order by expires_at asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        selectedId = candidate.rows[0]?.id ?? null;
        if (selectedId === null) return false;
        const updated = await sql`
          update delivery_bundle
          set status = 'EXPIRED', version = version + 1
          where id = ${selectedId}
            and status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
        `.execute(trx);
        return Number(updated.numAffectedRows ?? 0) === 1;
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null) throw new Error("bundle recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(expires_at) as oldest
    from delivery_bundle
    where status in ('CREATED','AVAILABLE','VIEWED')
      and expires_at < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}
