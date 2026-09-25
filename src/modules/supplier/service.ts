import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById } from "../commerce/repository.js";
import { validateAssetEnvelope } from "../digital-goods/asset-validation.js";
import {
  executeSupplierPurchase,
  recoverSupplierPurchase,
  type SupplierPurchaseRecord,
  type SupplierPurchaseRecordStore,
} from "./purchase-core.js";
import {
  hasSupplierCapability,
  type AssetEnvelope,
  type SupplierPort,
  type SupplierProvider,
} from "./port.js";
import { checkSupplierPurchaseReadiness } from "./readiness.js";
/**
 * Supplier provisioning service (T069, FR-015/FR-016).
 *
 * Wraps the Supplier Port into a persistent, crash-safe provisioning flow:
 *   1. record a SupplierOrder keyed by (supplier, idempotency_key) — create is
 *      idempotent, so a replay never issues a second upstream purchase;
 *   2. call the port; a transport timeout maps to UNKNOWN (recovered by
 *      `recoverUnknownSupplierOrder`, never a silent re-create);
 *   3. on a fulfilled envelope, validate it against the order's expectations —
 *      a mismatch quarantines the asset (SUPPLIER_NEEDS_REVIEW) instead of
 *      delivering it;
 *   4. ingest the validated asset as a SUPPLIER/READY DigitalAsset bound to the
 *      order, carrying only the vault ref (never plaintext).
 *
 * The `vault` dependency is the secret boundary for a real adapter (which writes
 * plaintext into the vault and hands back a ref); the sandbox adapter already
 * returns a `vault:` ref, so the service persists it as-is.
 */

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
  port: SupplierPort | SupplierProvider;
  vault: Vault;
  /** Stable idempotency key; derived from the order+sku when omitted. */
  idempotencyKey?: string;
  /** Required runtime launch gate; false must prevent all upstream purchase I/O. */
  purchaseEnabled: boolean;
}

export type ProvisionResult =
  | { ok: true; kind: "FULFILLED"; supplierOrderId: string; assetId: string }
  | { ok: true; kind: "UNKNOWN"; supplierOrderId: string; queryKey: string }
  | { ok: true; kind: "REJECTED"; supplierOrderId: string }
  | { ok: true; kind: "NEEDS_REVIEW"; supplierOrderId: string; assetId: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_PAID" | "UNSUPPORTED"; message: string };

export interface RecoverInput {
  supplierOrderId: string;
  queryKey: string;
  expectedSku: string;
  deliveryType: string;
  durationCode: string;
  region: string | null;
  correlationId: string;
  port: SupplierPort | SupplierProvider;
  vault: Vault;
}

export type RecoverResult =
  | { ok: true; kind: "FULFILLED"; assetId: string }
  | { ok: true; kind: "PENDING" }
  | { ok: true; kind: "REJECTED" }
  | { ok: true; kind: "NEEDS_REVIEW"; assetId: string }
  | { ok: false; code: "NOT_FOUND" | "UNSUPPORTED"; message: string };

interface SupplierOrderRow {
  id: string;
  order_id: string;
  supplier_id: string;
  supplier_sku_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: string;
  external_order_id: string | null;
  query_key: string | null;
  cost_vnd_snapshot: number | string;
  version: number;
  response_fingerprint: string | null;
  last_error_code: string | null;
  needs_review_at: Date | string | null;
}

function toPurchaseRecord(row: SupplierOrderRow): SupplierPurchaseRecord {
  const status: SupplierPurchaseRecord["status"] =
    row.status === "FULFILLED" ||
    row.status === "REJECTED" ||
    row.status === "PENDING" ||
    row.status === "UNKNOWN" ||
    row.status === "AUTHORIZED"
      ? row.status
      : "SUBMITTED";
  return {
    id: row.id,
    requestReference: row.order_id,
    supplierId: row.supplier_id,
    supplierSkuId: row.supplier_sku_id,
    queryKey: row.query_key,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status,
    externalOrderId: row.external_order_id,
    costVndSnapshot: Number(row.cost_vnd_snapshot),
    version: row.version,
    responseFingerprint: row.response_fingerprint,
    blockCode: row.last_error_code,
  };
}

async function findSupplierOrderByIdempotency(
  exec: Executor,
  supplierId: string,
  idempotencyKey: string,
): Promise<SupplierOrderRow | null> {
  const result = await sql<SupplierOrderRow>`
    select id, supplier_id, supplier_sku_id, order_id, idempotency_key,
           request_fingerprint, status, external_order_id, query_key, cost_vnd_snapshot,
           version, response_fingerprint, last_error_code, needs_review_at
    from supplier_order
    where supplier_id = ${supplierId} and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

async function findSupplierOrderById(exec: Executor, id: string): Promise<SupplierOrderRow | null> {
  const result = await sql<SupplierOrderRow>`
    select id, supplier_id, supplier_sku_id, order_id, idempotency_key,
           request_fingerprint, status, external_order_id, query_key, cost_vnd_snapshot,
           version, response_fingerprint, last_error_code, needs_review_at
    from supplier_order where id = ${id} limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

function createSupplierOrderStore(db: Db, salePriceVnd: number): SupplierPurchaseRecordStore {
  const load = async (id: string): Promise<SupplierOrderRow | null> =>
    findSupplierOrderById(db, id);
  return {
    async findByIdempotency(input) {
      const row = await findSupplierOrderByIdempotency(db, input.supplierId, input.idempotencyKey);
      return row ? toPurchaseRecord(row) : null;
    },
    async findById(id) {
      const row = await load(id);
      return row ? toPurchaseRecord(row) : null;
    },
    async insertIntent(input) {
      const id = newId();
      const inserted = await sql<{ id: string }>`
        insert into supplier_order
          (id, supplier_id, supplier_sku_id, order_id, idempotency_key, provider_client_order_id,
           request_fingerprint, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
           margin_vnd_snapshot, submitted_at, last_attempt_at, attempt_count)
        values
          (${id}, ${input.supplierId}, ${input.supplierSkuId}, ${input.requestReference},
           ${input.idempotencyKey}, ${input.idempotencyKey}, ${input.requestFingerprint}, 'SUBMITTED',
           ${input.costCeilingVnd}, ${salePriceVnd}, ${salePriceVnd - input.costCeilingVnd},
           now(), now(), 0)
        on conflict (supplier_id, idempotency_key) do nothing
        returning id
      `.execute(db);
      const row = await (inserted.rows[0]
        ? load(id)
        : findSupplierOrderByIdempotency(db, input.supplierId, input.idempotencyKey));
      if (!row) throw new Error("supplier idempotency winner was not visible after conflict wait");
      return { inserted: inserted.rows.length === 1, record: toPurchaseRecord(row) };
    },
    async refreshIntent(id, input) {
      await sql`
        update supplier_order
        set cost_vnd_snapshot = ${input.costCeilingVnd},
            margin_vnd_snapshot = ${salePriceVnd - input.costCeilingVnd},
            version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markAttempt(id) {
      const result = await sql<{ id: string }>`
        update supplier_order
        set status = 'SUBMITTED', attempt_count = attempt_count + 1, last_attempt_at = now(),
            last_error_code = null, retry_after_seconds = null, next_reconcile_at = null,
            version = version + 1
        where id = ${id} and status in ('SUBMITTED','AUTHORIZED') and attempt_count = 0
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },
    async markTransportFailure(id, input) {
      await sql`
        update supplier_order
        set last_error_code = ${input.code},
            retry_after_seconds = ${input.retryAfterSeconds ?? null},
            next_reconcile_at = ${
              input.retryAfterSeconds === null || input.retryAfterSeconds === undefined
                ? null
                : new Date(Date.now() + input.retryAfterSeconds * 1_000).toISOString()
            },
            version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markResponse(id, fingerprint) {
      await sql`
        update supplier_order
        set response_fingerprint = ${fingerprint}, version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markUnknown(id, input) {
      await sql`
        update supplier_order
        set status = 'UNKNOWN',
            query_key = ${input.queryKey},
            last_queried_at = now(), uncertain_at = now(), last_error_code = ${input.reason},
            version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markPending(id, externalOrderId) {
      await sql`
        update supplier_order
        set status = 'PENDING', external_order_id = ${externalOrderId}, query_key = null,
            last_queried_at = now(), last_error_code = null, version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markFulfilled(id, externalOrderId) {
      await sql`
        update supplier_order
        set status = 'FULFILLED', external_order_id = ${externalOrderId}, query_key = null, version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markRejected(id) {
      await sql`
        update supplier_order
        set status = 'REJECTED', version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markNeedsReview(id, code) {
      await sql`
        update supplier_order
        set last_error_code = ${code}, needs_review_at = coalesce(needs_review_at, now()),
            next_reconcile_at = null, version = version + 1
        where id = ${id}
      `.execute(db);
    },
    async markBlocked(id, code) {
      await sql`
        update supplier_order
        set status = 'REJECTED', last_error_code = ${code}, next_reconcile_at = null,
            version = version + 1
        where id = ${id}
      `.execute(db);
    },
  };
}

async function findAssetBySupplierOrder(
  exec: Executor,
  supplierOrderId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await sql<{ id: string; status: string }>`
    select id, status from digital_asset where supplier_order_id = ${supplierOrderId} limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

function provisionResultFromExisting(
  existing: SupplierOrderRow,
  asset: { id: string; status: string } | null,
): ProvisionResult | null {
  if (existing.status === "FULFILLED" && asset) {
    return asset.status === "SUPPLIER_NEEDS_REVIEW"
      ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: existing.id, assetId: asset.id }
      : { ok: true, kind: "FULFILLED", supplierOrderId: existing.id, assetId: asset.id };
  }
  if (existing.status === "REJECTED")
    return { ok: true, kind: "REJECTED", supplierOrderId: existing.id };
  return null;
}

function recoverResultFromAsset(asset: { id: string; status: string }): RecoverResult {
  return asset.status === "SUPPLIER_NEEDS_REVIEW"
    ? { ok: true, kind: "NEEDS_REVIEW", assetId: asset.id }
    : { ok: true, kind: "FULFILLED", assetId: asset.id };
}

/**
 * Ingest a validated supplier asset as a SUPPLIER/READY asset bound to the
 * order. On a validation mismatch the asset is quarantined (SUPPLIER_NEEDS_REVIEW)
 * instead of delivered. The shared purchase core marks the supplier order
 * FULFILLED after this transaction commits.
 */
async function ingestFulfilledAsset(
  db: Db,
  params: {
    supplierOrderId: string;
    orderId: string;
    variantId: string;
    envelope: AssetEnvelope;
    expectedSku: string;
    deliveryType: string;
    durationCode: string;
    region: string | null;
  },
): Promise<{ assetId: string; quarantined: boolean }> {
  const decision = validateAssetEnvelope(params.envelope, {
    expectedSku: params.expectedSku,
    deliveryType: params.deliveryType,
    durationCode: params.durationCode,
    region: params.region,
  });

  return withTransaction(db, async (trx) => {
    const locked = await sql<{ id: string }>`
      select id from supplier_order where id = ${params.supplierOrderId} for update
    `.execute(trx);
    if (!locked.rows[0]) throw new Error("Supplier order disappeared during fulfilled ingest");

    const existing = await findAssetBySupplierOrder(trx, params.supplierOrderId);
    if (existing) {
      return { assetId: existing.id, quarantined: existing.status === "SUPPLIER_NEEDS_REVIEW" };
    }

    const assetId = newId();
    const quarantined = !decision.ok;
    const status = quarantined ? "SUPPLIER_NEEDS_REVIEW" : "READY";
    const reservedOrderId = quarantined ? null : params.orderId;
    const summary = decision.ok
      ? { validated: true }
      : { quarantined: true, reasonCode: decision.reasonCode };

    await sql`
      insert into digital_asset
        (id, variant_id, source_type, supplier_order_id, vault_ref, fingerprint_hash,
         status, expires_at, region, reserved_order_id, validation_summary)
      values
        (${assetId}, ${params.variantId}, 'SUPPLIER', ${params.supplierOrderId},
         ${params.envelope.vaultRef}, ${params.envelope.fingerprint}, ${status},
         ${params.envelope.expiresAt}, ${params.envelope.region}, ${reservedOrderId},
         ${JSON.stringify(summary)}::jsonb)
    `.execute(trx);

    if (quarantined) {
      await sql`
        update supplier_order
        set needs_review_at = coalesce(needs_review_at, now())
        where id = ${params.supplierOrderId}
      `.execute(trx);
    }

    return { assetId, quarantined };
  });
}

export async function provisionFromSupplier(
  db: Db,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const order = await findOrderById(db, input.orderId);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }
  if (input.purchaseEnabled !== true) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "Mua từ nhà cung cấp đang bị khóa.",
    };
  }
  if ("capabilities" in input.port && !hasSupplierCapability(input.port, "ORDER_CREATE")) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "Nhà cung cấp chưa công bố capability đặt hàng.",
    };
  }
  if (order.status !== "PAID" && order.status !== "PROCESSING" && order.status !== "COMPLETED") {
    return { ok: false, code: "NOT_PAID", message: "Đơn hàng chưa được thanh toán." };
  }

  const idempotencyKey = input.idempotencyKey ?? `${input.orderId}:${input.supplierSkuId}`;
  const store = createSupplierOrderStore(db, input.salePriceVnd);
  const existingRecord = await store.findByIdempotency({
    supplierId: input.supplierId,
    idempotencyKey,
  });
  if (existingRecord && existingRecord.requestReference !== input.orderId) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }
  const existingRow = existingRecord ? await findSupplierOrderById(db, existingRecord.id) : null;
  const known = existingRow
    ? provisionResultFromExisting(existingRow, await findAssetBySupplierOrder(db, existingRow.id))
    : null;
  if (known) return known;

  const canReuseCompletedReplay = order.status === "COMPLETED" && existingRecord !== null;
  if (order.status !== "PAID" && order.status !== "PROCESSING" && !canReuseCompletedReplay) {
    return { ok: false, code: "NOT_PAID", message: "Đơn hàng chưa được thanh toán." };
  }

  if (existingRecord) {
    if (existingRecord.status === "UNKNOWN" || existingRecord.status === "PENDING") {
      const recovered = await recoverUnknownSupplierOrder(db, {
        supplierOrderId: existingRecord.id,
        queryKey: existingRecord.queryKey ?? existingRecord.externalOrderId ?? idempotencyKey,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
        correlationId: input.correlationId,
        port: input.port,
        vault: input.vault,
      });
      if (!recovered.ok) return { ok: false, code: recovered.code, message: recovered.message };
      if (recovered.kind === "FULFILLED") {
        return {
          ok: true,
          kind: "FULFILLED",
          supplierOrderId: existingRecord.id,
          assetId: recovered.assetId,
        };
      }
      if (recovered.kind === "NEEDS_REVIEW") {
        return {
          ok: true,
          kind: "NEEDS_REVIEW",
          supplierOrderId: existingRecord.id,
          assetId: recovered.assetId,
        };
      }
      if (recovered.kind === "REJECTED") {
        return { ok: true, kind: "REJECTED", supplierOrderId: existingRecord.id };
      }
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: existingRecord.id,
        queryKey: existingRecord.queryKey ?? existingRecord.externalOrderId ?? idempotencyKey,
      };
    }
    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: existingRecord.id,
      queryKey: existingRecord.queryKey ?? existingRecord.externalOrderId ?? idempotencyKey,
    };
  }

  const readiness = await checkSupplierPurchaseReadiness(db, {
    variantId: order.variantId,
    supplierId: input.supplierId,
    supplierSkuId: input.supplierSkuId,
    provider: input.port,
    purchaseEnabled: input.purchaseEnabled,
  });
  if (!readiness.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "Mapping nhà cung cấp hiện không đủ điều kiện mua.",
    };
  }

  let expectedSku =
    input.expectedSku === input.externalSku ? readiness.externalSku : input.expectedSku;
  let region = readiness.region;
  const result = await executeSupplierPurchase({
    supplierId: input.supplierId,
    supplierSkuId: input.supplierSkuId,
    requestReference: input.orderId,
    externalSku: readiness.externalSku,
    costCeilingVnd: readiness.costVnd,
    idempotencyKey,
    correlationId: input.correlationId,
    region,
    port: input.port,
    store,
    purchaseEnabled: input.purchaseEnabled,
    beforeCreate: async () => {
      const latest = await checkSupplierPurchaseReadiness(db, {
        variantId: order.variantId,
        supplierId: input.supplierId,
        supplierSkuId: input.supplierSkuId,
        provider: input.port,
        purchaseEnabled: input.purchaseEnabled,
      });
      if (!latest.ok) return { ok: false, code: latest.reason };
      expectedSku =
        input.expectedSku === input.externalSku ? latest.externalSku : input.expectedSku;
      region = latest.region;
      return {
        ok: true,
        externalSku: latest.externalSku,
        costCeilingVnd: latest.costVnd,
        region: latest.region,
      };
    },
    onFulfilled: async ({ record, assetEnvelope }) => {
      await ingestFulfilledAsset(db, {
        supplierOrderId: record.id,
        orderId: input.orderId,
        variantId: order.variantId,
        envelope: assetEnvelope,
        expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region,
      });
    },
  });

  if (result.kind === "BLOCKED") {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "Mapping nhà cung cấp hiện không đủ điều kiện mua.",
    };
  }
  if (result.kind === "UNKNOWN") {
    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: result.record.id,
      queryKey: result.queryKey,
    };
  }
  if (result.kind === "ACCEPTED") {
    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: result.record.id,
      queryKey: idempotencyKey,
    };
  }
  if (result.kind === "REJECTED" || result.kind === "REPLAY") {
    const row = await findSupplierOrderById(db, result.record.id);
    const asset = await findAssetBySupplierOrder(db, result.record.id);
    const replay = row ? provisionResultFromExisting(row, asset) : null;
    return replay ?? { ok: true, kind: "REJECTED", supplierOrderId: result.record.id };
  }

  const asset = await findAssetBySupplierOrder(db, result.record.id);
  if (!asset) throw new Error("fulfilled supplier purchase has no ingested asset");
  return asset.status === "SUPPLIER_NEEDS_REVIEW"
    ? { ok: true, kind: "NEEDS_REVIEW", supplierOrderId: result.record.id, assetId: asset.id }
    : { ok: true, kind: "FULFILLED", supplierOrderId: result.record.id, assetId: asset.id };
}

/**
 * Recover an UNKNOWN (or pending) supplier order by querying the provider.
 * Never re-creates upstream — query is the only path forward. A fulfilled
 * result is validated and ingested exactly like the create path.
 */
export async function recoverUnknownSupplierOrder(
  db: Db,
  input: RecoverInput,
): Promise<RecoverResult> {
  const so = await findSupplierOrderById(db, input.supplierOrderId);
  if (!so) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn nhà cung cấp." };
  }
  const order = await findOrderById(db, so.order_id);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }

  const result = await recoverSupplierPurchase({
    store: createSupplierOrderStore(db, Number(so.cost_vnd_snapshot)),
    recordId: so.id,
    queryKey: input.queryKey,
    port: input.port,
    onFulfilled: async ({ record, assetEnvelope }) => {
      await ingestFulfilledAsset(db, {
        supplierOrderId: record.id,
        orderId: so.order_id,
        variantId: order.variantId,
        envelope: assetEnvelope,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
      });
    },
  });
  if (result.kind === "BLOCKED") {
    return {
      ok: false,
      code: result.code === "NOT_FOUND" ? "NOT_FOUND" : "UNSUPPORTED",
      message:
        result.code === "DELIVERY_UNSUPPORTED"
          ? "Nhà cung cấp trả về payload giao hàng chưa được hỗ trợ."
          : "Nhà cung cấp chưa công bố capability truy vấn đơn hàng.",
    };
  }
  if (result.kind === "REJECTED") return { ok: true, kind: "REJECTED" };
  if (result.kind === "UNKNOWN") return { ok: true, kind: "PENDING" };
  if (result.kind === "REPLAY") {
    const asset = await findAssetBySupplierOrder(db, so.id);
    return asset ? recoverResultFromAsset(asset) : { ok: true, kind: "PENDING" };
  }
  if (result.kind !== "FULFILLED") return { ok: true, kind: "PENDING" };
  const asset = await findAssetBySupplierOrder(db, result.record.id);
  if (!asset) throw new Error("fulfilled supplier recovery has no ingested asset");
  return recoverResultFromAsset(asset);
}
