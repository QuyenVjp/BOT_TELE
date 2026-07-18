import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById } from "../commerce/repository.js";
import { validateAssetEnvelope } from "../digital-goods/asset-validation.js";
import type { AssetEnvelope, SupplierPort } from "./port.js";

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
  port: SupplierPort;
  vault: Vault;
  /** Stable idempotency key; derived from the order+sku when omitted. */
  idempotencyKey?: string;
}

export type ProvisionResult =
  | { ok: true; kind: "FULFILLED"; supplierOrderId: string; assetId: string }
  | { ok: true; kind: "UNKNOWN"; supplierOrderId: string; queryKey: string }
  | { ok: true; kind: "REJECTED"; supplierOrderId: string }
  | { ok: true; kind: "NEEDS_REVIEW"; supplierOrderId: string; assetId: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_PAID"; message: string };

export interface RecoverInput {
  supplierOrderId: string;
  queryKey: string;
  expectedSku: string;
  deliveryType: string;
  durationCode: string;
  region: string | null;
  correlationId: string;
  port: SupplierPort;
  vault: Vault;
}

export type RecoverResult =
  | { ok: true; kind: "FULFILLED"; assetId: string }
  | { ok: true; kind: "PENDING" }
  | { ok: true; kind: "REJECTED" }
  | { ok: true; kind: "NEEDS_REVIEW"; assetId: string }
  | { ok: false; code: "NOT_FOUND"; message: string };

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
): Promise<{ id: string } | null> {
  const result = await sql<{ id: string }>`
    select id from digital_asset where supplier_order_id = ${supplierOrderId} limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
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
    const assetId = newId();
    const quarantined = !decision.ok;
    const status = quarantined ? "SUPPLIER_NEEDS_REVIEW" : "READY";
    const reservedOrderId = quarantined ? null : params.orderId;
    const summary = quarantined
      ? { quarantined: true, reasonCode: decision.ok ? null : decision.reasonCode }
      : { validated: true };

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
  if (order.status !== "PAID" && order.status !== "PROCESSING") {
    return { ok: false, code: "NOT_PAID", message: "Đơn hàng chưa được thanh toán." };
  }

  const idempotencyKey = input.idempotencyKey ?? `${input.orderId}:${input.supplierSkuId}`;

  // Idempotent short-circuit: an already-fulfilled supplier order returns its asset.
  const existing = await findSupplierOrderByIdempotency(db, input.supplierId, idempotencyKey);
  if (existing && existing.status === "FULFILLED") {
    const asset = await findAssetBySupplierOrder(db, existing.id);
    if (asset) {
      return { ok: true, kind: "FULFILLED", supplierOrderId: existing.id, assetId: asset.id };
    }
  }

  // Record (or reuse) the supplier order as SUBMITTED before the upstream call.
  let supplierOrderId: string;
  if (existing) {
    supplierOrderId = existing.id;
  } else {
    supplierOrderId = newId();
    const costSnapshot = input.costCeilingVnd;
    const margin = input.salePriceVnd - costSnapshot;
    await sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot, submitted_at)
      values
        (${supplierOrderId}, ${input.supplierId}, ${input.supplierSkuId}, ${input.orderId},
         ${idempotencyKey}, ${requestFingerprint(input, idempotencyKey)}, 'SUBMITTED',
         ${costSnapshot}, ${input.salePriceVnd}, ${margin}, now())
    `.execute(db);
  }

  // Call the port (adapter dedupes on the same idempotency key).
  const result = await input.port.createOrder({
    idempotencyKey,
    supplierSku: input.externalSku,
    costCeilingVnd: input.costCeilingVnd,
    orderId: input.orderId,
    ...(input.region !== null ? { region: input.region } : {}),
  });

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
        set status = 'UNKNOWN', last_queried_at = now(), version = version + 1
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
            version = version + 1
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
  // Already recovered.
  if (so.status === "FULFILLED") {
    const asset = await findAssetBySupplierOrder(db, so.id);
    if (asset) return { ok: true, kind: "FULFILLED", assetId: asset.id };
  }

  const order = await findOrderById(db, so.order_id);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }

  const observed = await input.port.queryOrder({ queryKey: input.queryKey });

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
