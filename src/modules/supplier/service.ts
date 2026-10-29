import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import { validateAssetEnvelope } from "../digital-goods/asset-validation.js";
import { checkSupplierPurchaseReadiness, type SupplierPurchaseProvider } from "./readiness.js";
import {
  postClaimedSupplierPurchase,
  recoverSupplierPurchase,
  supplierPurchaseRequestFingerprint,
  SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2,
  type SupplierPurchaseRecord,
  type SupplierPurchaseRecordStore,
  type SupplierPurchaseResult,
} from "./purchase-core.js";
import { parseAssetEnvelope, hasSupplierCapability, type AssetEnvelope } from "./port.js";
import type { Vault } from "../../infrastructure/vault/port.js";
export interface ProvisionInput {
  orderId: string;
  supplierId: string;
  supplierSkuId: string;
  externalSku: string;
  costCeilingVnd: number;
  salePriceVnd: number;
  expectedSku: string;
  deliveryType: string;
  durationCode: string;
  region: string | null;
  correlationId: string;
  port: SupplierPurchaseProvider;
  vault: Vault;
  idempotencyKey?: string;
  purchaseEnabled: boolean;
}

export type ProvisionResult =
  | { ok: true; kind: "FULFILLED"; supplierOrderId: string; assetId: string }
  | { ok: true; kind: "UNKNOWN"; supplierOrderId: string; queryKey: string }
  | { ok: true; kind: "REJECTED"; supplierOrderId: string }
  | { ok: true; kind: "NEEDS_REVIEW"; supplierOrderId: string; assetId?: string }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_PAID" | "UNSUPPORTED" | "SUPPLIER_UNAVAILABLE" | "ORDER_TERMINAL";
      message: string;
    };

export interface RecoverInput {
  supplierOrderId: string;
  queryKey: string;
  expectedSku: string;
  deliveryType: string;
  durationCode: string;
  region: string | null;
  correlationId: string;
  port: SupplierPurchaseProvider;
  vault: Vault;
  purchaseEnabled?: boolean;
}

export type RecoverResult =
  | { ok: true; kind: "FULFILLED"; assetId: string }
  | { ok: true; kind: "PENDING" }
  | { ok: true; kind: "UNKNOWN"; queryKey: string }
  | { ok: true; kind: "REJECTED" }
  | { ok: true; kind: "NEEDS_REVIEW"; assetId?: string }
  | { ok: false; code: "NOT_FOUND" | "UNSUPPORTED" | "ORDER_TERMINAL"; message: string };

interface SupplierOrderDbRow {
  id: string;
  supplier_id: string;
  supplier_sku_id: string;
  order_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  request_fingerprint_version: number | null;
  status: string;
  external_order_id: string | null;
  query_key: string | null;
  cost_vnd_snapshot: string | number;
  submitted_at: Date | string | null;
  last_queried_at: Date | string | null;
  version: number;
  provider_client_order_id: string | null;
  response_fingerprint: string | null;
  attempt_count: number;
  last_error_code: string | null;
  retry_after_seconds: number | null;
  uncertain_at: Date | string | null;
  needs_review_at: Date | string | null;
}

function mapSupplierOrder(row: SupplierOrderDbRow): SupplierPurchaseRecord {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierSkuId: row.supplier_sku_id,
    requestReference: row.order_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    requestFingerprintVersion: row.request_fingerprint_version,
    status: row.status as SupplierPurchaseRecord["status"],
    externalOrderId: row.external_order_id,
    queryKey: row.query_key,
    submittedAt: row.submitted_at,
    needsReviewAt: row.needs_review_at,
    costVndSnapshot: Number(row.cost_vnd_snapshot),
    version: row.version,
    responseFingerprint: row.response_fingerprint,
    attemptCount: row.attempt_count,
  };
}

const SUPPLIER_ORDER_COLUMNS = sql`id, supplier_id, supplier_sku_id, order_id, idempotency_key,
  request_fingerprint, request_fingerprint_version, status, external_order_id, query_key,
  cost_vnd_snapshot, submitted_at, last_queried_at, version, provider_client_order_id,
  response_fingerprint, attempt_count, last_error_code, retry_after_seconds, uncertain_at,
  needs_review_at`;

async function findSupplierOrderByIdempotency(
  exec: Executor,
  supplierId: string,
  idempotencyKey: string,
): Promise<SupplierPurchaseRecord | null> {
  const result = await sql<SupplierOrderDbRow>`
    select ${SUPPLIER_ORDER_COLUMNS}
    from supplier_order
    where supplier_id = ${supplierId} and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(exec);
  return result.rows[0] ? mapSupplierOrder(result.rows[0]) : null;
}

async function findSupplierOrderByOrder(
  exec: Executor,
  orderId: string,
): Promise<SupplierPurchaseRecord | null> {
  const result = await sql<SupplierOrderDbRow>`
    select ${SUPPLIER_ORDER_COLUMNS}
    from supplier_order where order_id = ${orderId}
    order by id asc limit 1
  `.execute(exec);
  return result.rows[0] ? mapSupplierOrder(result.rows[0]) : null;
}

async function findSupplierOrderById(
  exec: Executor,
  id: string,
): Promise<SupplierPurchaseRecord | null> {
  const result = await sql<SupplierOrderDbRow>`
    select ${SUPPLIER_ORDER_COLUMNS} from supplier_order where id = ${id} limit 1
  `.execute(exec);
  return result.rows[0] ? mapSupplierOrder(result.rows[0]) : null;
}

async function findAssetBySupplierOrder(
  exec: Executor,
  supplierOrderId: string,
): Promise<{ id: string; status: string; vault_ref: string } | null> {
  const result = await sql<{ id: string; status: string; vault_ref: string }>`
    select id, status, vault_ref
    from digital_asset
    where supplier_order_id = ${supplierOrderId}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

function isOrderTerminal(status: string): boolean {
  return [
    "CANCELLED",
    "REFUNDED",
    "REJECTED",
    "EXPIRED",
    "PAYMENT_NEEDS_REVIEW",
    "REFUND_PENDING",
  ].includes(status);
}

function resultFromAsset(
  supplierOrderId: string,
  asset: { id: string; status: string },
): ProvisionResult {
  return asset.status === "SUPPLIER_NEEDS_REVIEW"
    ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId, assetId: asset.id }
    : { ok: true, kind: "FULFILLED", supplierOrderId, assetId: asset.id };
}

function recoverResultFromAsset(asset: { id: string; status: string }): RecoverResult {
  return asset.status === "SUPPLIER_NEEDS_REVIEW"
    ? { ok: true, kind: "NEEDS_REVIEW", assetId: asset.id }
    : { ok: true, kind: "FULFILLED", assetId: asset.id };
}

function createSupplierOrderStore(exec: Executor): SupplierPurchaseRecordStore {
  return {
    async findByIdempotency(input) {
      return findSupplierOrderByIdempotency(exec, input.supplierId, input.idempotencyKey);
    },
    async findById(id) {
      return findSupplierOrderById(exec, id);
    },
    async insertIntent(input) {
      const id = newId();
      const salePriceVnd = input.salePriceVnd ?? input.costCeilingVnd;
      const inserted = await sql<SupplierOrderDbRow>`
        insert into supplier_order
          (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
           request_fingerprint_version, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
           margin_vnd_snapshot, submitted_at, query_key, attempt_count)
        values
          (${id}, ${input.supplierId}, ${input.supplierSkuId}, ${input.requestReference},
           ${input.idempotencyKey}, ${input.requestFingerprint},
           ${input.requestFingerprintVersion ?? SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2},
           'SUBMITTED', ${input.costCeilingVnd}, ${salePriceVnd}, ${salePriceVnd - input.costCeilingVnd}, null, null, 0)
        on conflict (supplier_id, idempotency_key) do nothing
        returning ${SUPPLIER_ORDER_COLUMNS}
      `.execute(exec);
      if (inserted.rows[0]) return { inserted: true, record: mapSupplierOrder(inserted.rows[0]) };
      const existing = await findSupplierOrderByIdempotency(
        exec,
        input.supplierId,
        input.idempotencyKey,
      );
      if (!existing)
        throw new Error("supplier idempotency winner was not visible after conflict wait");
      return { inserted: false, record: existing };
    },
    async markAttempt(id, input) {
      const result = await sql`
        update supplier_order
        set provider_client_order_id = idempotency_key,
            query_key = coalesce(query_key, idempotency_key),
            status = 'SUBMITTED',
            submitted_at = coalesce(submitted_at, now()),
            last_attempt_at = now(),
            attempt_count = attempt_count + 1,
            request_fingerprint = ${input.requestFingerprint},
            request_fingerprint_version = ${input.requestFingerprintVersion},
            cost_vnd_snapshot = ${input.costCeilingVnd},
            last_error_code = null, retry_after_seconds = null, uncertain_at = null,
            version = version + 1
        where id = ${id} and status in ('SUBMITTED','AUTHORIZED') and attempt_count = 0
          and needs_review_at is null
      `.execute(exec);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    async markTransportFailure(id, input) {
      await sql`
        update supplier_order
        set last_error_code = ${input.code}, retry_after_seconds = ${input.retryAfterSeconds ?? null},
            uncertain_at = now(), version = version + 1
        where id = ${id} and status in ('SUBMITTED','AUTHORIZED','PENDING','UNKNOWN')
          and needs_review_at is null
      `.execute(exec);
    },
    async markResponse(id, fingerprint) {
      await sql`
        update supplier_order set response_fingerprint = ${fingerprint}, version = version + 1
        where id = ${id}
      `.execute(exec);
    },
    async markUnknown(id, input) {
      await sql`
        update supplier_order
        set status = 'UNKNOWN', query_key = ${input.queryKey}, uncertain_at = coalesce(uncertain_at, now()),
            last_error_code = ${input.reason}, last_queried_at = now(), version = version + 1
        where id = ${id} and status not in ('FULFILLED','REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
          and needs_review_at is null
      `.execute(exec);
    },
    async markPending(id, externalOrderId) {
      await sql`
        update supplier_order
        set status = 'PENDING', external_order_id = ${externalOrderId}, query_key = null,
            last_queried_at = now(), version = version + 1
        where id = ${id} and status not in ('FULFILLED','REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
          and needs_review_at is null
      `.execute(exec);
    },
    async markFulfilled(id, externalOrderId) {
      await sql`
        update supplier_order
        set status = 'FULFILLED', external_order_id = ${externalOrderId},
            query_key = coalesce(query_key, idempotency_key), uncertain_at = null,
            last_error_code = null, retry_after_seconds = null, version = version + 1
        where id = ${id} and status not in ('REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
          and needs_review_at is null
      `.execute(exec);
    },
    async markRejected(id) {
      await sql`
        update supplier_order set status = 'REJECTED', last_queried_at = now(), version = version + 1
        where id = ${id} and status not in ('FULFILLED','REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
          and needs_review_at is null
      `.execute(exec);
    },
    async markNeedsReview(id, code) {
      await sql`
        update supplier_order
        set needs_review_at = coalesce(needs_review_at, now()),
            last_error_code = case when needs_review_at is null then ${code} else last_error_code end,
            version = version + 1
        where id = ${id} and status not in ('FULFILLED','REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
      `.execute(exec);
    },
    async markBlocked(id, code) {
      await sql`
        update supplier_order
        set status = 'REJECTED', last_error_code = ${code}, version = version + 1
        where id = ${id} and status not in ('FULFILLED','REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
          and needs_review_at is null
      `.execute(exec);
    },
  };
}

async function verifyVaultRef(vault: Vault, ref: string): Promise<boolean> {
  if (!/^vault:\S{1,512}$/u.test(ref)) return false;
  try {
    await vault.health?.();
    const material = await vault.reveal(ref);
    return typeof material === "string" && material.length > 0;
  } catch {
    return false;
  }
}

async function ingestFulfilledAsset(
  db: Db,
  params: {
    supplierOrderId: string;
    orderId: string;
    variantId: string;
    externalOrderId: string;
    envelope: AssetEnvelope;
    expectedSku: string;
    deliveryType: string;
    durationCode: string;
    region: string | null;
    vault: Vault;
  },
): Promise<{ assetId: string; quarantined: boolean } | null> {
  let envelope: AssetEnvelope;
  try {
    envelope = parseAssetEnvelope(params.envelope);
  } catch {
    return null;
  }
  const decision = validateAssetEnvelope(envelope, {
    expectedSku: params.expectedSku,
    deliveryType: params.deliveryType,
    durationCode: params.durationCode,
    region: params.region,
  });
  return withTransaction(db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, params.orderId);
    if (!order || isOrderTerminal(order.status)) return null;
    const locked = await sql<SupplierOrderDbRow>`
      select ${SUPPLIER_ORDER_COLUMNS}
      from supplier_order
      where id = ${params.supplierOrderId}
      for update
    `.execute(trx);
    const supplierOrder = locked.rows[0];
    if (!supplierOrder) return null;
    if (["REJECTED", "CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(supplierOrder.status)) {
      return null;
    }
    if (supplierOrder.needs_review_at !== null) return null;
    const expectedExternalOrderId =
      supplierOrder.status === "UNKNOWN" && supplierOrder.query_key === null
        ? null
        : supplierOrder.external_order_id;
    if (expectedExternalOrderId !== null && expectedExternalOrderId !== params.externalOrderId) {
      await sql`
        update supplier_order
        set needs_review_at = coalesce(needs_review_at, now()),
            last_error_code = 'IDENTITY_MISMATCH',
            version = version + 1
        where id = ${params.supplierOrderId}
      `.execute(trx);
      await sql`
        update digital_asset
        set status = 'SUPPLIER_NEEDS_REVIEW',
            reserved_order_id = null,
            reserved_until = null,
            validation_summary = '{"quarantined":true,"reasonCode":"IDENTITY_MISMATCH"}'::jsonb,
            updated_at = now(),
            version = version + 1
        where supplier_order_id = ${params.supplierOrderId}
          and status in ('AVAILABLE','RESERVED','READY','PROVISIONING')
          and delivered_order_id is null
      `.execute(trx);
      return null;
    }

    const existing = await findAssetBySupplierOrder(trx, params.supplierOrderId);
    if (existing) {
      if (!decision.ok) {
        await sql`
          update supplier_order
          set needs_review_at = coalesce(needs_review_at, now()),
              last_error_code = case
                when needs_review_at is null then ${decision.reasonCode}
                else last_error_code
              end,
              version = version + 1
          where id = ${params.supplierOrderId}
        `.execute(trx);
        await sql`
          update digital_asset
          set status = 'SUPPLIER_NEEDS_REVIEW',
              reserved_order_id = null,
              reserved_until = null,
              validation_summary = ${JSON.stringify({
                quarantined: true,
                reasonCode: decision.reasonCode,
              })}::jsonb,
              updated_at = now(),
              version = version + 1
          where id = ${existing.id}
            and status in ('AVAILABLE','RESERVED','READY','PROVISIONING')
            and delivered_order_id is null
        `.execute(trx);
        return { assetId: existing.id, quarantined: true };
      }
      if (
        existing.status !== "SUPPLIER_NEEDS_REVIEW" &&
        !(await verifyVaultRef(params.vault, existing.vault_ref))
      ) {
        await sql`
          update supplier_order
          set needs_review_at = coalesce(needs_review_at, now()),
              last_error_code = case
                when needs_review_at is null then 'VAULT_UNAVAILABLE'
                else last_error_code
              end,
              version = version + 1
          where id = ${params.supplierOrderId}
        `.execute(trx);
        await sql`
          update digital_asset
          set status = 'SUPPLIER_NEEDS_REVIEW',
              reserved_order_id = null,
              validation_summary = '{"quarantined":true,"reasonCode":"VAULT_UNAVAILABLE"}'::jsonb,
              updated_at = now(),
              version = version + 1
          where id = ${existing.id}
            and status not in ('DELIVERED','REVOKED')
        `.execute(trx);
        return { assetId: existing.id, quarantined: true };
      }
      return { assetId: existing.id, quarantined: existing.status === "SUPPLIER_NEEDS_REVIEW" };
    }

    const vaultVerified = decision.ok && (await verifyVaultRef(params.vault, envelope.vaultRef));
    const quarantined = !decision.ok || !vaultVerified;
    const quarantineReason = decision.ok ? "VAULT_UNAVAILABLE" : decision.reasonCode;
    const status = quarantined ? "SUPPLIER_NEEDS_REVIEW" : "READY";
    const validationSummary = quarantined
      ? {
          quarantined: true,
          reasonCode: quarantineReason,
        }
      : { validated: true };
    const assetId = newId();
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, supplier_order_id, vault_ref, fingerprint_hash,
         status, expires_at, region, reserved_order_id, validation_summary)
      values
        (${assetId}, ${params.variantId}, 'SUPPLIER', ${params.supplierOrderId},
         ${envelope.vaultRef}, ${envelope.fingerprint}, ${status},
         ${envelope.expiresAt}, ${envelope.region},
         ${quarantined ? null : params.orderId},
         ${JSON.stringify(validationSummary)}::jsonb)
    `.execute(trx);
    await sql`
      update supplier_order
      set status = 'FULFILLED',
          external_order_id = coalesce(external_order_id, ${params.externalOrderId}),
          needs_review_at = case
            when ${quarantined} then coalesce(needs_review_at, now())
            else needs_review_at
          end,
          last_error_code = case
            when ${quarantined} and needs_review_at is null then ${quarantineReason}
            else last_error_code
          end,
          uncertain_at = null,
          version = version + 1
      where id = ${params.supplierOrderId}
        and status not in ('REJECTED','CANCELLED','REFUNDED','REFUND_PENDING')
        and needs_review_at is null
    `.execute(trx);
    return { assetId, quarantined };
  });
}

function mapCoreResult(result: SupplierPurchaseResult, idempotencyKey: string): ProvisionResult {
  switch (result.kind) {
    case "FULFILLED":
      return {
        ok: true,
        kind: "FULFILLED",
        supplierOrderId: result.record.id,
        assetId: result.record.id,
      };
    case "REJECTED":
      return { ok: true, kind: "REJECTED", supplierOrderId: result.record.id };
    case "UNKNOWN":
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: result.record.id,
        queryKey: result.queryKey || idempotencyKey,
      };
    case "ACCEPTED":
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: result.record.id,
        queryKey: result.externalOrderId || idempotencyKey,
      };
    case "REPLAY":
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: result.record.id,
        queryKey: result.record.queryKey ?? idempotencyKey,
      };
    case "BLOCKED":
      return {
        ok: false,
        code: result.code === "ORDER_TERMINAL" ? "ORDER_TERMINAL" : "UNSUPPORTED",
        message: "Nhà cung cấp hiện không khả dụng.",
      };
  }
}

interface ClaimResult {
  status: "CLAIMED" | "NOT_READY" | "TERMINAL" | "ALREADY";
  record: SupplierPurchaseRecord | null;
  readiness: { externalSku: string; costVnd: number; region: string | null } | null;
}

async function claimSupplierCreate(
  db: Db,
  input: ProvisionInput,
  initialReadiness: { externalSku: string; costVnd: number; region: string | null },
): Promise<ClaimResult> {
  return withTransaction(db, async (trx) => {
    const order = await findOrderByIdForUpdate(trx, input.orderId);
    if (!order || isOrderTerminal(order.status))
      return { status: "TERMINAL", record: null, readiness: null };

    const existingRows = await sql<SupplierOrderDbRow>`
      select ${SUPPLIER_ORDER_COLUMNS}
      from supplier_order
      where order_id = ${input.orderId}
      order by id asc
      for update
    `.execute(trx);
    if (existingRows.rows.length > 1) return { status: "TERMINAL", record: null, readiness: null };

    const existingRow = existingRows.rows[0];
    if (
      existingRow &&
      (existingRow.supplier_id !== input.supplierId ||
        existingRow.supplier_sku_id !== input.supplierSkuId)
    ) {
      return { status: "TERMINAL", record: mapSupplierOrder(existingRow), readiness: null };
    }
    if (
      existingRow &&
      (existingRow.attempt_count > 0 ||
        existingRow.submitted_at !== null ||
        existingRow.query_key !== null ||
        ["FULFILLED", "REJECTED", "CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(
          existingRow.status,
        ))
    ) {
      return { status: "ALREADY", record: mapSupplierOrder(existingRow), readiness: null };
    }

    const mapping = await checkSupplierPurchaseReadiness(trx, {
      variantId: order.variantId,
      supplierId: input.supplierId,
      supplierSkuId: input.supplierSkuId,
      provider: input.port,
      purchaseEnabled: input.purchaseEnabled,
      mappingOnly: true,
    });
    if (
      !mapping.ok ||
      mapping.externalSku !== initialReadiness.externalSku ||
      mapping.costVnd !== initialReadiness.costVnd ||
      mapping.region !== initialReadiness.region
    ) {
      return {
        status: "NOT_READY",
        record: existingRow ? mapSupplierOrder(existingRow) : null,
        readiness: null,
      };
    }
    const readiness = mapping;

    const store = createSupplierOrderStore(trx);
    const idempotencyKey =
      existingRow?.idempotency_key ??
      input.idempotencyKey ??
      `${input.orderId}:${input.supplierSkuId}`;
    const record = existingRow
      ? mapSupplierOrder(existingRow)
      : (
          await store.insertIntent({
            supplierId: input.supplierId,
            supplierSkuId: input.supplierSkuId,
            requestReference: input.orderId,
            idempotencyKey,
            requestFingerprint: supplierPurchaseRequestFingerprint({
              supplierId: input.supplierId,
              supplierSkuId: input.supplierSkuId,
              requestReference: input.orderId,
              idempotencyKey,
              externalSku: readiness.externalSku,
              costCeilingVnd: readiness.costVnd,
              region: readiness.region,
            }),
            requestFingerprintVersion: SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2,
            salePriceVnd: input.salePriceVnd,
            costCeilingVnd: readiness.costVnd,
          })
        ).record;

    if (
      record.requestReference !== input.orderId ||
      record.supplierId !== input.supplierId ||
      record.supplierSkuId !== input.supplierSkuId
    ) {
      return { status: "TERMINAL", record, readiness: null };
    }
    if (
      (record.attemptCount ?? 0) > 0 ||
      record.submittedAt !== null ||
      record.queryKey !== null ||
      ["FULFILLED", "REJECTED", "CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(record.status)
    ) {
      return { status: "ALREADY", record, readiness: null };
    }

    const claimed = await store.markAttempt(record.id, {
      costCeilingVnd: readiness.costVnd,
      requestFingerprint: supplierPurchaseRequestFingerprint({
        supplierId: input.supplierId,
        supplierSkuId: input.supplierSkuId,
        requestReference: input.orderId,
        idempotencyKey: record.idempotencyKey,
        externalSku: readiness.externalSku,
        costCeilingVnd: readiness.costVnd,
        region: readiness.region,
      }),
      requestFingerprintVersion: SUPPLIER_REQUEST_FINGERPRINT_VERSION_V2,
    });
    if (!claimed) {
      return {
        status: "ALREADY",
        record: (await findSupplierOrderById(trx, record.id)) ?? record,
        readiness: null,
      };
    }
    if (order.status === "PAID") {
      await transitionOrder(
        trx,
        order,
        "PROCESSING",
        "SUPPLIER_PURCHASE_CLAIMED",
        input.correlationId,
        { type: "SYSTEM", id: null },
      );
    }
    return {
      status: "CLAIMED",
      record: (await findSupplierOrderById(trx, record.id)) ?? record,
      readiness,
    };
  });
}

function terminalResult(
  code: "NOT_FOUND" | "NOT_PAID" | "ORDER_TERMINAL" | "UNSUPPORTED" | "SUPPLIER_UNAVAILABLE",
): ProvisionResult {
  const messages: Record<typeof code, string> = {
    NOT_FOUND: "Không tìm thấy đơn hàng.",
    NOT_PAID: "Đơn hàng chưa được thanh toán.",
    ORDER_TERMINAL: "Đơn hàng đã kết thúc.",
    UNSUPPORTED: "Nhà cung cấp hiện không khả dụng.",
    SUPPLIER_UNAVAILABLE: "Nhà cung cấp hiện không khả dụng.",
  };
  return { ok: false, code, message: messages[code] };
}

export async function provisionFromSupplier(
  db: Db,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const order = await findOrderById(db, input.orderId);
  if (!order) return terminalResult("NOT_FOUND");
  if (isOrderTerminal(order.status)) return terminalResult("ORDER_TERMINAL");
  if (!["PAID", "PROCESSING", "COMPLETED"].includes(order.status))
    return terminalResult("NOT_PAID");

  const idempotencyKey = input.idempotencyKey ?? `${input.orderId}:${input.supplierSkuId}`;
  const existingByKey = await findSupplierOrderByIdempotency(db, input.supplierId, idempotencyKey);
  const existingByOrder = await findSupplierOrderByOrder(db, input.orderId);
  const existing = existingByKey ?? existingByOrder;
  if (existing) {
    if (
      existing.requestReference !== input.orderId ||
      existing.supplierId !== input.supplierId ||
      existing.supplierSkuId !== input.supplierSkuId
    ) {
      return terminalResult("ORDER_TERMINAL");
    }
    const asset = await findAssetBySupplierOrder(db, existing.id);
    if (asset && existing.status === "FULFILLED") {
      return existing.needsReviewAt != null
        ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: existing.id, assetId: asset.id }
        : resultFromAsset(existing.id, asset);
    }
    if (["CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(existing.status))
      return terminalResult("ORDER_TERMINAL");
    if (existing.status === "REJECTED")
      return { ok: true, kind: "REJECTED", supplierOrderId: existing.id };
    const attempted =
      existing.status !== "SUBMITTED" ||
      (existing.attemptCount ?? 0) > 0 ||
      existing.submittedAt !== null ||
      existing.queryKey !== null;
    if (attempted) {
      const recovered = await recoverUnknownSupplierOrder(db, {
        supplierOrderId: existing.id,
        queryKey: existing.queryKey ?? existing.externalOrderId ?? existing.idempotencyKey,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
        correlationId: input.correlationId,
        port: input.port,
        vault: input.vault,
        purchaseEnabled: input.purchaseEnabled,
      });
      if (!recovered.ok) return terminalResult(recovered.code);
      if (recovered.kind === "FULFILLED") {
        return {
          ok: true,
          kind: "FULFILLED",
          supplierOrderId: existing.id,
          assetId: recovered.assetId,
        };
      }
      if (recovered.kind === "NEEDS_REVIEW") {
        return {
          ok: true,
          kind: "NEEDS_REVIEW",
          supplierOrderId: existing.id,
          ...(recovered.assetId === undefined ? {} : { assetId: recovered.assetId }),
        };
      }
      if (recovered.kind === "REJECTED")
        return { ok: true, kind: "REJECTED", supplierOrderId: existing.id };
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: existing.id,
        queryKey: existing.queryKey ?? existing.externalOrderId ?? existing.idempotencyKey,
      };
    }
  }

  if (!input.purchaseEnabled) return terminalResult("UNSUPPORTED");
  if (
    "capabilities" in input.port &&
    (!(input.port.capabilities instanceof Set) ||
      !hasSupplierCapability(input.port, "ORDER_CREATE"))
  ) {
    return terminalResult("UNSUPPORTED");
  }

  const readiness = await checkSupplierPurchaseReadiness(db, {
    variantId: order.variantId,
    supplierId: input.supplierId,
    supplierSkuId: input.supplierSkuId,
    provider: input.port,
    purchaseEnabled: input.purchaseEnabled,
  });
  if (!readiness.ok) {
    return terminalResult(
      readiness.reason === "SUPPLIER_UNSUPPORTED" ? "UNSUPPORTED" : "SUPPLIER_UNAVAILABLE",
    );
  }

  const claim = await claimSupplierCreate(db, input, readiness);
  if (claim.status === "TERMINAL") return terminalResult("ORDER_TERMINAL");
  if (claim.status === "NOT_READY") return terminalResult("SUPPLIER_UNAVAILABLE");
  if (claim.status === "ALREADY" && claim.record) {
    if (claim.record.status === "FULFILLED") {
      const asset = await findAssetBySupplierOrder(db, claim.record.id);
      if (asset) {
        return claim.record.needsReviewAt != null
          ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: claim.record.id, assetId: asset.id }
          : resultFromAsset(claim.record.id, asset);
      }
    }
    if (claim.record.status === "REJECTED")
      return { ok: true, kind: "REJECTED", supplierOrderId: claim.record.id };
    if (["CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(claim.record.status))
      return terminalResult("ORDER_TERMINAL");
    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: claim.record.id,
      queryKey:
        claim.record.queryKey ?? claim.record.externalOrderId ?? claim.record.idempotencyKey,
    };
  }
  if (!claim.record || !claim.readiness) return terminalResult("UNSUPPORTED");

  const core = await postClaimedSupplierPurchase(
    {
      supplierId: input.supplierId,
      supplierSkuId: input.supplierSkuId,
      requestReference: input.orderId,
      externalSku: claim.readiness.externalSku,
      costCeilingVnd: claim.readiness.costVnd,
      idempotencyKey: claim.record.idempotencyKey,
      correlationId: input.correlationId,
      region: claim.readiness.region,
      port: input.port,
      store: createSupplierOrderStore(db),
      purchaseEnabled: input.purchaseEnabled,
      beforePost: async () => {
        // claimSupplierCreate serialized the first attempt by fencing PAID -> PROCESSING
        // under the order lock; supported cancel/refund paths cannot win after that fence.
        const latestOrder = await findOrderById(db, input.orderId);
        if (!latestOrder || isOrderTerminal(latestOrder.status)) {
          return { ok: false as const, code: "ORDER_TERMINAL" };
        }
        const latest = await checkSupplierPurchaseReadiness(db, {
          variantId: order.variantId,
          supplierId: input.supplierId,
          supplierSkuId: input.supplierSkuId,
          provider: input.port,
          purchaseEnabled: input.purchaseEnabled,
        });
        const latestOrderAfterProbe = await findOrderById(db, input.orderId);
        if (!latestOrderAfterProbe || isOrderTerminal(latestOrderAfterProbe.status)) {
          return { ok: false as const, code: "ORDER_TERMINAL" };
        }
        return latest.ok
          ? {
              ok: true as const,
              costCeilingVnd: latest.costVnd,
              externalSku: latest.externalSku,
              region: latest.region,
            }
          : { ok: false as const, code: "SUPPLIER_MAPPING_CHANGED" };
      },
      onFulfilled: async ({ externalOrderId, assetEnvelope }) =>
        (await ingestFulfilledAsset(db, {
          supplierOrderId: claim.record!.id,
          orderId: input.orderId,
          variantId: order.variantId,
          externalOrderId,
          envelope: assetEnvelope,
          expectedSku: input.expectedSku,
          deliveryType: input.deliveryType,
          durationCode: input.durationCode,
          region: input.region,
          vault: input.vault,
        })) !== null,
    },
    claim.record,
    {
      externalSku: claim.readiness.externalSku,
      costCeilingVnd: claim.readiness.costVnd,
      region: claim.readiness.region,
    },
  );
  if (core.kind === "FULFILLED") {
    const asset = await findAssetBySupplierOrder(db, claim.record.id);
    if (!asset)
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: claim.record.id,
        queryKey: idempotencyKey,
      };
    return resultFromAsset(claim.record.id, asset);
  }
  if (core.kind === "REPLAY") {
    const asset = await findAssetBySupplierOrder(db, claim.record.id);
    if (asset) {
      const current = await findSupplierOrderById(db, claim.record.id);
      return current?.needsReviewAt != null
        ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: claim.record.id, assetId: asset.id }
        : resultFromAsset(claim.record.id, asset);
    }
    const current = await findSupplierOrderById(db, claim.record.id);
    if (current?.needsReviewAt != null) {
      return { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: claim.record.id };
    }
    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: claim.record.id,
      queryKey: idempotencyKey,
    };
  }
  return mapCoreResult(core, idempotencyKey);
}

export async function recoverUnknownSupplierOrder(
  db: Db,
  input: RecoverInput,
): Promise<RecoverResult> {
  const supplierOrder = await findSupplierOrderById(db, input.supplierOrderId);
  if (!supplierOrder)
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn nhà cung cấp." };
  const asset = await findAssetBySupplierOrder(db, supplierOrder.id);
  if (supplierOrder.needsReviewAt != null) {
    return asset
      ? asset.status === "SUPPLIER_NEEDS_REVIEW"
        ? recoverResultFromAsset(asset)
        : { ok: true, kind: "NEEDS_REVIEW", assetId: asset.id }
      : { ok: true, kind: "NEEDS_REVIEW" };
  }
  if (asset && supplierOrder.status === "FULFILLED") return recoverResultFromAsset(asset);
  if (["CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(supplierOrder.status)) {
    return { ok: false, code: "ORDER_TERMINAL", message: "Đơn hàng đã kết thúc." };
  }
  const order = await findOrderById(db, supplierOrder.requestReference);
  if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  if (isOrderTerminal(order.status))
    return { ok: false, code: "ORDER_TERMINAL", message: "Đơn hàng đã kết thúc." };
  if (
    "capabilities" in input.port &&
    (!(input.port.capabilities instanceof Set) ||
      !hasSupplierCapability(input.port, "ORDER_READ") ||
      !hasSupplierCapability(input.port, "DELIVERY_PAYLOAD"))
  ) {
    return { ok: false, code: "UNSUPPORTED", message: "Nhà cung cấp hiện không khả dụng." };
  }

  const core = await recoverSupplierPurchase({
    store: createSupplierOrderStore(db),
    recordId: supplierOrder.id,
    queryKey: input.queryKey,
    expectedSku: input.expectedSku,
    port: input.port,
    beforeQuery: async () => {
      const current = await findOrderById(db, supplierOrder.requestReference);
      return current !== null && !isOrderTerminal(current.status);
    },
    onFulfilled: async ({ externalOrderId, assetEnvelope }) =>
      (await ingestFulfilledAsset(db, {
        supplierOrderId: supplierOrder.id,
        orderId: order.id,
        variantId: order.variantId,
        externalOrderId,
        envelope: assetEnvelope,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
        vault: input.vault,
      })) !== null,
  });
  if (core.kind === "FULFILLED") {
    const recoveredAsset = await findAssetBySupplierOrder(db, supplierOrder.id);
    return recoveredAsset ? recoverResultFromAsset(recoveredAsset) : { ok: true, kind: "PENDING" };
  }
  if (core.kind === "REPLAY") {
    const recoveredAsset = await findAssetBySupplierOrder(db, supplierOrder.id);
    if (recoveredAsset) return recoverResultFromAsset(recoveredAsset);
    const current = await findSupplierOrderById(db, supplierOrder.id);
    if (current?.needsReviewAt != null) return { ok: true, kind: "NEEDS_REVIEW" };
    if (current?.status === "REJECTED") return { ok: true, kind: "REJECTED" };
    return { ok: true, kind: "PENDING" };
  }
  if (core.kind === "REJECTED") {
    const current = await findSupplierOrderById(db, supplierOrder.id);
    return current?.needsReviewAt != null
      ? { ok: true, kind: "NEEDS_REVIEW" }
      : { ok: true, kind: "REJECTED" };
  }
  if (core.kind === "UNKNOWN") {
    const current = await findSupplierOrderById(db, supplierOrder.id);
    if (current?.needsReviewAt != null) return { ok: true, kind: "NEEDS_REVIEW" };
    return current?.status === "PENDING"
      ? { ok: true, kind: "PENDING" }
      : { ok: true, kind: "UNKNOWN", queryKey: core.queryKey };
  }
  if (core.kind === "BLOCKED") {
    if (core.code === "SUPPLIER_ORDER_NOT_QUERYABLE") return { ok: true, kind: "NEEDS_REVIEW" };
    if (core.code === "SCHEMA_INVALID" && core.record?.needsReviewAt != null) {
      return { ok: true, kind: "NEEDS_REVIEW" };
    }
    return {
      ok: false,
      code: core.code === "ORDER_TERMINAL" ? "ORDER_TERMINAL" : "UNSUPPORTED",
      message: "Nhà cung cấp hiện không khả dụng.",
    };
  }
  return { ok: false, code: "UNSUPPORTED", message: "Nhà cung cấp hiện không khả dụng." };
}
