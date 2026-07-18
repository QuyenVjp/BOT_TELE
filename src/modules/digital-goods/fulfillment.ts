import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { findOrderById, transitionOrder } from "../commerce/repository.js";
import type { SupplierPort } from "../supplier/port.js";
import { issueDeliveryBundle } from "./delivery.js";
import {
  claimLocalAssetInTransaction,
  findActiveAssetHoldByOrderForUpdate,
  markAssetReady,
} from "./repository.js";

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
  /** Optional supplier port; null disables the supplier path. */
  supplier: SupplierPort | null;
  deliveryBaseUrl: string;
  bundleTtlSeconds: number;
  deliveryTokenKeys?: readonly string[];
}

export type FulfillErrorCode =
  "NOT_FOUND" | "NOT_PAID" | "OUT_OF_STOCK" | "NEEDS_REVIEW" | "ISSUE_FAILED";

export type FulfillResult =
  | {
      ok: true;
      orderId: string;
      customerId: string;
      assetId: string;
      bundleId: string;
      token: string;
      deliveryUrl: string;
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

  // 2. Claim/promote the asset and append DigitalAssetClaimed in one unit of
  // work. Existing pre-payment reservations are upgraded through the same path.
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

    // Re-entry repairs a historical READY row that predates this atomic path,
    // while the asset row lock prevents concurrent duplicate repair.
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
        payloadRedacted: {
          assetId: held.id,
          orderId,
          vaultRef: held.vault_ref,
          correlationId,
        },
      });
    }

    return claim;
  });

  if (!prepared.ok) {
    if (deps.supplier === null) {
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

  const assetId = prepared.assetId;

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
    orderId,
    customerId: order.customerId,
    assetId,
    bundleId: issued.bundleId,
    token: issued.token,
    deliveryUrl,
  };
}
