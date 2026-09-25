import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById } from "../commerce/repository.js";
import { validateAssetEnvelope } from "../digital-goods/asset-validation.js";
import {
  hasSupplierCapability,
  SupplierPortError,
  type AssetEnvelope,
  type CreateOrderResult,
  type SupplierPort,
  type SupplierProvider,
} from "./port.js";
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
  status: string;
  external_order_id: string | null;
  version: number;
}

function requestFingerprint(input: ProvisionInput, idempotencyKey: string): string {
  return createHash("sha256")
    .update(`${input.supplierId}|${input.supplierSkuId}|${input.orderId}|${idempotencyKey}`, "utf8")
    .digest("hex");
}

function retryAfterFromError(error: unknown): number | null {
  if (!(error instanceof SupplierPortError)) return null;
  const value = (error as SupplierPortError & { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 86_400)
    : null;
}

async function findSupplierOrderByIdempotency(
  exec: Executor,
  supplierId: string,
  idempotencyKey: string,
): Promise<SupplierOrderRow | null> {
  const result = await sql<SupplierOrderRow>`
    select id, order_id, status, external_order_id, version
    from supplier_order
    where supplier_id = ${supplierId} and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

async function findSupplierOrderById(exec: Executor, id: string): Promise<SupplierOrderRow | null> {
  const result = await sql<SupplierOrderRow>`
    select id, order_id, status, external_order_id, version
    from supplier_order where id = ${id} limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
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
 * order, then move the supplier order to FULFILLED — atomically. On a
 * validation mismatch the asset is quarantined (SUPPLIER_NEEDS_REVIEW) and left
 * unreserved so it can never be delivered.
 */
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

    // Supplier order is FULFILLED regardless (the upstream purchase happened);
    // the asset quarantine is what blocks delivery.
    await sql`
      update supplier_order
      set status = 'FULFILLED',
          external_order_id = ${params.externalOrderId},
          needs_review_at = ${quarantined ? new Date().toISOString() : null},
          version = version + 1
      where id = ${params.supplierOrderId}
    `.execute(trx);

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
  const existing = await findSupplierOrderByIdempotency(db, input.supplierId, idempotencyKey);
  if (existing && existing.order_id !== input.orderId) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }
  if (existing) {
    const known = provisionResultFromExisting(
      existing,
      await findAssetBySupplierOrder(db, existing.id),
    );
    if (known) return known;
  }

  const canReuseCompletedReplay = order.status === "COMPLETED" && existing !== null;
  if (order.status !== "PAID" && order.status !== "PROCESSING" && !canReuseCompletedReplay) {
    return { ok: false, code: "NOT_PAID", message: "Đơn hàng chưa được thanh toán." };
  }

  if (existing) {
    if (existing.status === "UNKNOWN" || existing.status === "PENDING") {
      const recovered = await recoverUnknownSupplierOrder(db, {
        supplierOrderId: existing.id,
        queryKey: existing.external_order_id ?? idempotencyKey,
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
          supplierOrderId: existing.id,
          assetId: recovered.assetId,
        };
      }
      if (recovered.kind === "NEEDS_REVIEW") {
        return {
          ok: true,
          kind: "NEEDS_REVIEW",
          supplierOrderId: existing.id,
          assetId: recovered.assetId,
        };
      }
      if (recovered.kind === "REJECTED")
        return { ok: true, kind: "REJECTED", supplierOrderId: existing.id };
      return {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: existing.id,
        queryKey: existing.external_order_id ?? idempotencyKey,
      };
    }

    return {
      ok: true,
      kind: "UNKNOWN",
      supplierOrderId: existing.id,
      queryKey: existing.external_order_id ?? idempotencyKey,
    };
  }

  // Insert the durable winner before external I/O. ON CONFLICT waits for a concurrent
  // winner, then the loser returns that in-flight state without creating or querying.
  const supplierOrderId = newId();
  const costSnapshot = input.costCeilingVnd;
  const margin = input.salePriceVnd - costSnapshot;
  const inserted = await sql<{ id: string }>`
    insert into supplier_order
      (id, supplier_id, supplier_sku_id, order_id, idempotency_key, provider_client_order_id,
       request_fingerprint, status, cost_vnd_snapshot, sale_price_vnd_snapshot,
       margin_vnd_snapshot, submitted_at, last_attempt_at, attempt_count)
    values
      (${supplierOrderId}, ${input.supplierId}, ${input.supplierSkuId}, ${input.orderId},
       ${idempotencyKey}, ${idempotencyKey}, ${requestFingerprint(input, idempotencyKey)}, 'SUBMITTED',
       ${costSnapshot}, ${input.salePriceVnd}, ${margin}, now(), now(), 0)
    on conflict (supplier_id, idempotency_key) do nothing
    returning id
  `.execute(db);

  if (!inserted.rows[0]) {
    const winner = await findSupplierOrderByIdempotency(db, input.supplierId, idempotencyKey);
    if (!winner) throw new Error("supplier idempotency winner was not visible after conflict wait");
    const known = provisionResultFromExisting(
      winner,
      await findAssetBySupplierOrder(db, winner.id),
    );
    return (
      known ?? {
        ok: true,
        kind: "UNKNOWN",
        supplierOrderId: winner.id,
        queryKey: winner.external_order_id ?? idempotencyKey,
      }
    );
  }

  await sql`
    update supplier_order
    set attempt_count = attempt_count + 1, last_attempt_at = now(),
        last_error_code = null, retry_after_seconds = null, next_reconcile_at = null,
        version = version + 1
    where id = ${supplierOrderId}
  `.execute(db);

  let result: CreateOrderResult;
  try {
    result = await input.port.createOrder({
      idempotencyKey,
      supplierSku: input.externalSku,
      costCeilingVnd: input.costCeilingVnd,
      orderId: input.orderId,
      ...(input.region !== null ? { region: input.region } : {}),
    });
  } catch (error) {
    const retryAfterSeconds = retryAfterFromError(error);
    const nextReconcileAt =
      retryAfterSeconds === null
        ? null
        : new Date(Date.now() + retryAfterSeconds * 1_000).toISOString();
    await sql`
      update supplier_order
      set last_error_code = ${error instanceof SupplierPortError ? error.supplierCode : "PORT_ERROR"},
          retry_after_seconds = ${retryAfterSeconds},
          next_reconcile_at = ${nextReconcileAt},
          version = version + 1
      where id = ${supplierOrderId}
    `.execute(db);
    throw error;
  }

  const responseFingerprint = createHash("sha256")
    .update(JSON.stringify(result), "utf8")
    .digest("hex");
  await sql`
    update supplier_order
    set response_fingerprint = ${responseFingerprint}, version = version + 1
    where id = ${supplierOrderId}
  `.execute(db);

  switch (result.kind) {
    case "FULFILLED": {
      const { assetId, quarantined } = await ingestFulfilledAsset(db, {
        supplierOrderId,
        orderId: input.orderId,
        variantId: order.variantId,
        externalOrderId: result.externalOrderId,
        envelope: result.assetEnvelope,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
      });
      if (quarantined) {
        return { ok: true, kind: "NEEDS_REVIEW", supplierOrderId, assetId };
      }
      return { ok: true, kind: "FULFILLED", supplierOrderId, assetId };
    }
    case "UNKNOWN": {
      await sql`
        update supplier_order
        set status = 'UNKNOWN', external_order_id = coalesce(external_order_id, ${result.queryKey}),
            last_queried_at = now(), uncertain_at = now(), last_error_code = ${result.reason},
            version = version + 1
        where id = ${supplierOrderId}
      `.execute(db);
      return { ok: true, kind: "UNKNOWN", supplierOrderId, queryKey: result.queryKey };
    }
    case "REJECTED": {
      await sql`
        update supplier_order set status = 'REJECTED', version = version + 1
        where id = ${supplierOrderId}
      `.execute(db);
      return { ok: true, kind: "REJECTED", supplierOrderId };
    }
    case "ACCEPTED":
    default: {
      // ACCEPTED (pending upstream) — keep SUBMITTED/PENDING; recovered by query.
      await sql`
        update supplier_order
        set status = 'PENDING', external_order_id = ${result.kind === "ACCEPTED" ? result.externalOrderId : null},
            last_error_code = null, version = version + 1
        where id = ${supplierOrderId}
      `.execute(db);
      return { ok: true, kind: "UNKNOWN", supplierOrderId, queryKey: idempotencyKey };
    }
  }
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
  if ("capabilities" in input.port && !hasSupplierCapability(input.port, "ORDER_READ")) {
    await sql`
      update supplier_order
      set last_error_code = 'UNSUPPORTED', needs_review_at = coalesce(needs_review_at, now()),
          next_reconcile_at = null, version = version + 1
      where id = ${so.id} and needs_review_at is null
    `.execute(db);
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "Nhà cung cấp chưa công bố capability truy vấn đơn hàng.",
    };
  }
  // Already recovered.
  if (so.status === "FULFILLED") {
    const asset = await findAssetBySupplierOrder(db, so.id);
    if (asset) return recoverResultFromAsset(asset);
  }

  const order = await findOrderById(db, so.order_id);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }

  let observed: Awaited<ReturnType<SupplierPort["queryOrder"]>>;
  try {
    observed = await input.port.queryOrder({ queryKey: input.queryKey });
  } catch (error) {
    if (error instanceof SupplierPortError && error.supplierCode === "DELIVERY_UNSUPPORTED") {
      await sql`
        update supplier_order
        set last_error_code = 'DELIVERY_UNSUPPORTED', needs_review_at = coalesce(needs_review_at, now()),
            next_reconcile_at = null, version = version + 1
        where id = ${so.id} and needs_review_at is null
      `.execute(db);
      return {
        ok: false,
        code: "UNSUPPORTED",
        message: "Nhà cung cấp trả về payload giao hàng chưa được hỗ trợ.",
      };
    }
    throw error;
  }

  switch (observed.status) {
    case "FULFILLED": {
      const { assetId, quarantined } = await ingestFulfilledAsset(db, {
        supplierOrderId: so.id,
        orderId: so.order_id,
        variantId: order.variantId,
        externalOrderId: observed.externalOrderId,
        envelope: observed.assetEnvelope,
        expectedSku: input.expectedSku,
        deliveryType: input.deliveryType,
        durationCode: input.durationCode,
        region: input.region,
      });
      if (quarantined) return { ok: true, kind: "NEEDS_REVIEW", assetId };
      return { ok: true, kind: "FULFILLED", assetId };
    }
    case "REJECTED":
    case "CANCELLED":
    case "REFUNDED": {
      await sql`
        update supplier_order set status = 'REJECTED', last_queried_at = now(), version = version + 1
        where id = ${so.id}
      `.execute(db);
      return { ok: true, kind: "REJECTED" };
    }
    case "PENDING":
    default: {
      await sql`
        update supplier_order set last_queried_at = now(), version = version + 1
        where id = ${so.id}
      `.execute(db);
      return { ok: true, kind: "PENDING" };
    }
  }
}
