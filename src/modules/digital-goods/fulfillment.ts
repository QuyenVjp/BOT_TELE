import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";
import type { SupplierPort } from "../supplier/port.js";
import { issueDeliveryBundle } from "./delivery.js";
import {
  claimLocalAssetInTransaction,
  findActiveAssetHoldByOrderForUpdate,
  markAssetReady,
} from "./repository.js";
import { createManualFulfillmentTaskForOrder, getManualTaskByOrder } from "./manual-fulfillment.js";
import { provisionFromSupplier } from "../supplier/service.js";

/**
 * Paid-Order fulfillment orchestrator (T071, FR-013–FR-017, SR-006).
 *
 * Begins only after verified payment. Policy is local-then-supplier:
 *   1. re-entry: if the order already holds an asset + active bundle, reuse them;
 *   2. claim one AVAILABLE local asset (atomic, SC-006);
 *   3. mark the asset READY and issue a Delivery Bundle;
 *   4. transition the Order PAID → PROCESSING and emit DigitalAssetClaimed.
 *
 * When local stock is empty and a supplier port is wired, a later slice will
 * create an idempotent SupplierOrder; today the orchestrator returns
 * OUT_OF_STOCK / NEEDS_REVIEW rather than inventing a silent fulfillment.
 *
 * Safe under crash/replay: every step is idempotent on its unique-effect key
 * (held asset per order, active bundle per order, outbox dedupe).
 */

export interface FulfillmentDeps {
  vault: Vault;
  /** Legacy single supplier fallback for fixtures; production uses supplierResolver. */
  supplier: SupplierPort | null;
  supplierResolver?: ((supplierId: string) => SupplierPort | null) | undefined;
  supplierPurchaseEnabled?: ((supplierId: string) => boolean) | undefined;
  deliveryBaseUrl: string;
  bundleTtlSeconds: number;
  deliveryTokenKeys?: readonly string[];
}
export type FulfillErrorCode =
  | "NOT_FOUND"
  | "NOT_PAID"
  | "OUT_OF_STOCK"
  | "NEEDS_REVIEW"
  | "SUPPLIER_PENDING"
  | "SUPPLIER_UNSUPPORTED"
  | "ISSUE_FAILED";

export type FulfillResult =
  | {
      ok: true;
      kind: "DELIVERY_BUNDLE";
      orderId: string;
      customerId: string;
      assetId: string;
      bundleId: string;
      token: string;
      deliveryUrl: string;
    }
  | {
      ok: true;
      kind: "WAITING_MANUAL";
      orderId: string;
      customerId: string;
      taskId: string;
      fulfillmentType: "MANUAL_FULFILLMENT" | "UNLIMITED_SERVICE" | "QUANTITY_STOCK";
    }
  | { ok: false; code: FulfillErrorCode; message: string };

export interface FulfillInput {
  orderId: string;
  correlationId: string;
  deps: FulfillmentDeps;
}

export async function fulfillPaidOrder(db: Db, input: FulfillInput): Promise<FulfillResult> {
  const { orderId, correlationId, deps } = input;

  // 1. Load order and enforce FR-013 (verified payment only).
  const order = await findOrderById(db, orderId);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }
  // Re-entry is allowed on PROCESSING/COMPLETED (crash recovery); first entry
  // requires PAID.
  const payable =
    order.status === "PAID" || order.status === "PROCESSING" || order.status === "COMPLETED";
  if (!payable) {
    return { ok: false, code: "NOT_PAID", message: "Đơn hàng chưa được thanh toán." };
  }

  if (
    order.fulfillmentType === "MANUAL_FULFILLMENT" ||
    order.fulfillmentType === "UNLIMITED_SERVICE" ||
    order.fulfillmentType === "QUANTITY_STOCK"
  ) {
    const taskResult = await withTransaction(db, async (trx) => {
      const live = await findOrderByIdForUpdate(trx, orderId);
      if (
        !live ||
        (live.status !== "PAID" && live.status !== "PROCESSING" && live.status !== "COMPLETED")
      ) {
        return {
          ok: false as const,
          code: "NOT_PAID" as const,
          message: "Đơn hàng chưa được thanh toán.",
        };
      }
      if (live.status === "COMPLETED") {
        const existing = await getManualTaskByOrder(trx, orderId);
        return existing
          ? { ok: true as const, task: existing, inserted: false }
          : {
              ok: false as const,
              code: "NOT_PAID" as const,
              message: "Đơn hàng chưa được thanh toán.",
            };
      }
      if (live.fulfillmentType === "QUANTITY_STOCK") {
        const reserved = await sql<{ one: number }>`
          select 1 as one
          from quantity_stock_ledger
          where order_id = ${orderId}
            and variant_id = ${live.variantId}
            and entry_type = 'RESERVE'
            and released_at is null
          limit 1
          for update
        `.execute(trx);
        if (!reserved.rows[0]) {
          return { ok: false as const, code: "OUT_OF_STOCK" as const };
        }
      }
      const task = await createManualFulfillmentTaskForOrder(trx, {
        orderId,
        customerId: live.customerId,
        variantId: live.variantId,
        correlationId,
      });
      if (!task.ok) return task;
      if (live.status === "PAID") {
        await transitionOrder(trx, live, "PROCESSING", "FULFILLMENT_STARTED", correlationId, {
          type: "SYSTEM",
          id: "fulfillment",
        });
      }
      return task;
    });
    if (!taskResult.ok) {
      if (taskResult.code === "NOT_PAID") return taskResult;
      return {
        ok: false,
        code: "OUT_OF_STOCK",
        message: "Chưa cấu hình xử lý thủ công cho sản phẩm này.",
      };
    }
    return {
      ok: true,
      kind: "WAITING_MANUAL",
      orderId,
      customerId: order.customerId,
      taskId: taskResult.task.id,
      fulfillmentType: taskResult.task.fulfillmentType,
    };
  }

  let assetId: string | null = null;
  let selectedSupplier: SupplierPort | null = null;
  if (order.fulfillmentType === "SUPPLIER_API") {
    const supplierSku = await sql<{
      supplier_id: string;
      supplier_sku_id: string;
      external_sku: string;
      cost_vnd: string | number;
      region: string | null;
    }>`
      select s.id as supplier_id, ss.id as supplier_sku_id, ss.external_sku, ss.cost_vnd, ss.region
      from supplier_sku ss
      join supplier s on s.id = ss.supplier_id
      where ss.variant_id = ${order.variantId}
        and ss.id = (select supplier_sku_id from product_variant where id = ${order.variantId})
        and ss.is_active
        and s.status = 'ACTIVE'
      limit 1
    `.execute(db);
    const sku = supplierSku.rows[0];
    if (!sku) {
      return {
        ok: false,
        code: "NEEDS_REVIEW",
        message: "Không tìm thấy SKU nhà cung cấp chính đang hoạt động.",
      };
    }
    if (deps.supplierPurchaseEnabled && !deps.supplierPurchaseEnabled(sku.supplier_id)) {
      return {
        ok: false,
        code: "SUPPLIER_UNSUPPORTED",
        message: "Mua từ nhà cung cấp đang bị khóa.",
      };
    }
    selectedSupplier = deps.supplierResolver
      ? deps.supplierResolver(sku.supplier_id)
      : deps.supplier;
    if (!selectedSupplier) {
      return {
        ok: false,
        code: "NEEDS_REVIEW",
        message: "Nhà cung cấp chính chưa được cấu hình.",
      };
    }
    const provision = await provisionFromSupplier(db, {
      orderId,
      supplierId: sku.supplier_id,
      supplierSkuId: sku.supplier_sku_id,
      externalSku: sku.external_sku,
      costCeilingVnd: Number(sku.cost_vnd),
      salePriceVnd: Number(order.priceVnd),
      expectedSku: sku.external_sku,
      deliveryType: order.deliveryType,
      durationCode: order.durationCode,
      region: sku.region,
      correlationId,
      port: selectedSupplier,
      vault: deps.vault,
      idempotencyKey: `${orderId}:${sku.supplier_sku_id}`,
      purchaseEnabled: deps.supplierPurchaseEnabled?.(sku.supplier_id) ?? true,
    });
    if (!provision.ok) {
      return {
        ...provision,
        code: provision.code === "UNSUPPORTED" ? "SUPPLIER_UNSUPPORTED" : provision.code,
      };
    }
    if (provision.kind === "UNKNOWN") {
      return {
        ok: false,
        code: "SUPPLIER_PENDING",
        message: "Nhà cung cấp đang xử lý; sẽ thử lại bằng truy vấn trạng thái.",
      };
    }
    if (provision.kind === "REJECTED" || provision.kind === "NEEDS_REVIEW") {
      return {
        ok: false,
        code: "NEEDS_REVIEW",
        message: "Nhà cung cấp cần đối soát trước khi giao.",
      };
    }
    assetId = provision.assetId;
  }

  // 2. Claim/promote the asset and append DigitalAssetClaimed in one unit of
  // work. Existing pre-payment reservations are upgraded through the same path.
  if (!assetId) {
    const prepared = await withTransaction(db, async (trx) => {
      const claim = await claimLocalAssetInTransaction(trx, {
        orderId,
        variantId: order.variantId,
        correlationId,
      });
      if (!claim.ok) return claim;

      const held = await findActiveAssetHoldByOrderForUpdate(trx, orderId);
      if (!held) {
        throw new Error("claimed asset disappeared before fulfillment event append");
      }
      let eventVersion = held.version;
      if (held.status === "RESERVED") {
        if (!(await markAssetReady(trx, held.id, held.version))) {
          throw new Error("claimed asset could not transition to READY");
        }
        eventVersion = nextVersion(held.version);
      }

      const existingEvent = await sql<{ one: number }>`
        select 1 as one from outbox_event
        where aggregate_type = 'DigitalAsset'
          and aggregate_id = ${held.id}
          and event_type = 'DigitalAssetClaimed'
        limit 1
      `.execute(trx);
      if (existingEvent.rows.length === 0) {
        await enqueueOutboxEvent(trx, {
          id: newId(),
          aggregateType: "DigitalAsset",
          aggregateId: held.id,
          aggregateVersion: eventVersion,
          eventType: "DigitalAssetClaimed",
          payloadRedacted: { assetId: held.id, orderId, vaultRef: held.vault_ref, correlationId },
        });
      }

      return claim;
    });

    if (!prepared.ok) {
      if (selectedSupplier === null) {
        return {
          ok: false,
          code: "OUT_OF_STOCK",
          message: "Không còn tài khoản khả dụng cho sản phẩm này.",
        };
      }
      return {
        ok: false,
        code: "NEEDS_REVIEW",
        message: "Hết hàng nội bộ; chờ đối soát nhà cung cấp.",
      };
    }
    assetId = prepared.assetId;
  }

  if (!assetId) throw new Error("fulfillment did not produce an asset");

  // 4. Issue (or reuse) the Delivery Bundle.
  const issued = await issueDeliveryBundle(db, {
    orderId,
    customerId: order.customerId,
    assetId,
    ttlSeconds: deps.bundleTtlSeconds,
    correlationId,
    ...(deps.deliveryTokenKeys ? { deliveryTokenKeys: deps.deliveryTokenKeys } : {}),
  });
  if (!issued.ok) {
    return { ok: false, code: "ISSUE_FAILED", message: issued.message };
  }

  // 5. Transition PAID → PROCESSING once (idempotent on re-entry).
  if (order.status === "PAID") {
    await withTransaction(db, async (trx) => {
      const live = await findOrderById(trx, orderId);
      if (live && live.status === "PAID") {
        await transitionOrder(trx, live, "PROCESSING", "FULFILLMENT_STARTED", correlationId, {
          type: "SYSTEM",
          id: "fulfillment",
        });
      }
    });
  }

  const deliveryUrl = `${deps.deliveryBaseUrl.replace(/\/$/, "")}/${issued.token || issued.bundleId}`;

  return {
    ok: true,
    kind: "DELIVERY_BUNDLE",
    orderId,
    customerId: order.customerId,
    assetId,
    bundleId: issued.bundleId,
    token: issued.token,
    deliveryUrl,
  };
}
