import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import {
  findOrderByIdForOwner,
  findOrderByIdForOwnerForUpdate,
  findOrderByIdForUpdate,
  transitionOrder,
} from "../commerce/repository.js";
import { issueReplacementDeliveryBundleInTransaction } from "./delivery.js";
import { findDeliveredAssetHistoryForOrder } from "./repository.js";

/**
 * Replacement / refund-request workflow (T078, FR-020).
 *
 * Opens a recorded ReplacementCase that preserves the original asset and Order
 * history. The original asset is never rewritten or deleted: a replacement
 * (when fulfilled later) is a new asset linked via `replacement_asset_id`. A
 * refund request moves the Order to REFUND_PENDING without mutating delivery
 * history. Both paths are audit-friendly and fail-closed on ownership /
 * warranty / status checks.
 */

export type ReplacementReasonCode =
  | "INVALID_CREDENTIAL"
  | "EXPIRED_ON_DELIVERY"
  | "WRONG_REGION"
  | "WRONG_DURATION"
  | "CUSTOMER_REQUEST"
  | "COMPROMISED";

export type ReplacementCaseStatus =
  "OPEN" | "APPROVED" | "REPLACED" | "REFUND_REQUESTED" | "REJECTED" | "CLOSED";

export type OpenReplacementResult =
  | { ok: true; caseId: string; status: ReplacementCaseStatus }
  | {
      ok: false;
      code: "NOT_FOUND" | "NO_ASSET" | "NOT_ELIGIBLE" | "WARRANTY_EXPIRED";
      message: string;
    };

export interface OpenReplacementInput {
  orderId: string;
  customerId: string;
  reasonCode: ReplacementReasonCode;
  /** Request a refund review instead of a replacement asset. */
  requestRefund?: boolean;
  correlationId: string;
  /** Injectable clock for warranty-deadline tests. */
  now?: Date;
}

export type ApproveReplacementResult =
  | {
      ok: true;
      caseId: string;
      orderId: string;
      customerId: string;
      replacementAssetId: string;
      bundleId: string;
      token: string;
      reused: boolean;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_ELIGIBLE" | "OUT_OF_STOCK" | "DELIVERY_FAILED";
      message: string;
    };

export interface ApproveReplacementInput {
  caseId: string;
  approvedBy: string;
  correlationId: string;
  deliveryBaseUrl: string;
  bundleTtlSeconds: number;
  deliveryTokenKeys?: readonly string[];
}

/**
 * Open a replacement/refund case for a delivered (or ready) asset. Ownership is
 * enforced against the Order's customer. The original asset row is left intact.
 */
export async function openReplacementCase(
  db: Db,
  input: OpenReplacementInput,
): Promise<OpenReplacementResult> {
  // Ownership is in the query at both the pre-check and the locked re-read: a foreign order and
  // a missing one are the same refusal, so a guessed id yields no existence oracle.
  const found = await findOrderByIdForOwner(db, input.orderId, input.customerId);
  if (!found) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }

  return withTransaction(db, async (trx) => {
    const order = await findOrderByIdForOwnerForUpdate(trx, input.orderId, input.customerId);
    if (!order) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
    }

    // Eligible once the order has been paid and fulfillment has started/finished.
    const eligible = [
      "PAID",
      "PROCESSING",
      "COMPLETED",
      "FULFILLMENT_NEEDS_REVIEW",
      "REFUND_PENDING",
    ].includes(order.status);
    if (!eligible) {
      return {
        ok: false,
        code: "NOT_ELIGIBLE",
        message: "Đơn hàng chưa đủ điều kiện thay thế/hoàn tiền.",
      };
    }

    const asset = await findDeliveredAssetHistoryForOrder(trx, order.id);
    if (!asset) {
      return { ok: false, code: "NO_ASSET", message: "Đơn hàng chưa có tài khoản để thay thế." };
    }

    // Warranty: order.warrantyDays from the immutable snapshot; 0 means no window
    // (still allow a case for COMPROMISED / INVALID_CREDENTIAL policy reasons, but
    // refuse pure CUSTOMER_REQUEST past the deadline).
    const now = input.now ?? new Date();
    if (order.warrantyDays > 0 && order.paidAt) {
      const paidAt = new Date(order.paidAt);
      const deadline = new Date(paidAt.getTime() + order.warrantyDays * 86_400_000);
      if (
        now.getTime() > deadline.getTime() &&
        (input.reasonCode === "CUSTOMER_REQUEST" || input.reasonCode === "EXPIRED_ON_DELIVERY")
      ) {
        return {
          ok: false,
          code: "WARRANTY_EXPIRED",
          message: "Đã quá thời hạn bảo hành cho yêu cầu này.",
        };
      }
    }

    const existing = await sql<{ id: string; status: ReplacementCaseStatus }>`
      select id, status
      from replacement_case
      where order_id = ${order.id}
        and original_asset_id = ${asset.id}
        and status in ('OPEN','APPROVED','REFUND_REQUESTED')
      order by opened_at asc, id asc
      limit 1
      for update
    `.execute(trx);

    const wantRefund = input.requestRefund === true;
    const existingCase = existing.rows[0];
    if (existingCase) {
      if (wantRefund && existingCase.status !== "REFUND_REQUESTED") {
        await sql`
          update replacement_case
          set status = 'REFUND_REQUESTED'
          where id = ${existingCase.id}
        `.execute(trx);
        if (
          order.status === "PAID" ||
          order.status === "PROCESSING" ||
          order.status === "COMPLETED"
        ) {
          await transitionOrder(
            trx,
            order,
            "REFUND_PENDING",
            "REFUND_REQUESTED",
            input.correlationId,
            {
              type: "customer",
              id: input.customerId,
            },
          );
        }
        return { ok: true, caseId: existingCase.id, status: "REFUND_REQUESTED" };
      }
      return { ok: true, caseId: existingCase.id, status: existingCase.status };
    }

    const status: ReplacementCaseStatus = wantRefund ? "REFUND_REQUESTED" : "OPEN";
    const caseId = newId();
    const warrantyDeadline =
      order.warrantyDays > 0 && order.paidAt
        ? new Date(new Date(order.paidAt).getTime() + order.warrantyDays * 86_400_000)
        : null;

    await sql`
      insert into replacement_case
        (id, order_id, original_asset_id, reason_code, status, warranty_deadline)
      values
        (${caseId}, ${order.id}, ${asset.id}, ${input.reasonCode}, ${status},
         ${warrantyDeadline ? warrantyDeadline.toISOString() : null})
    `.execute(trx);

    // A refund request moves the Order into REFUND_PENDING so finance can act;
    // a pure replacement stays on the current status (support fulfills later).
    if (wantRefund) {
      if (
        order.status === "PAID" ||
        order.status === "PROCESSING" ||
        order.status === "COMPLETED"
      ) {
        await transitionOrder(
          trx,
          order,
          "REFUND_PENDING",
          "REFUND_REQUESTED",
          input.correlationId,
          {
            type: "customer",
            id: input.customerId,
          },
        );
      }
    }

    return { ok: true, caseId, status };
  });
}

export async function approveReplacementCase(
  db: Db,
  input: ApproveReplacementInput,
): Promise<ApproveReplacementResult> {
  return withTransaction(db, (trx) => approveReplacementCaseInTransaction(trx, input));
}

export async function approveReplacementCaseInTransaction(
  exec: Executor,
  input: ApproveReplacementInput,
): Promise<ApproveReplacementResult> {
  const targetResult = await sql<{ case_id: string; order_id: string }>`
    select id as case_id, order_id
    from replacement_case
    where id = ${input.caseId}
    limit 1
  `.execute(exec);
  const target = targetResult.rows[0];
  if (!target) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu thay thế." };

  const order = await findOrderByIdForUpdate(exec, target.order_id);
  if (!order) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu thay thế." };

  const existing = await sql<{
    case_id: string;
    status: ReplacementCaseStatus;
    order_id: string;
    original_asset_id: string;
    replacement_asset_id: string | null;
    customer_id: string;
    variant_id: string;
  }>`
    select rc.id as case_id, rc.status, rc.order_id, rc.original_asset_id,
           rc.replacement_asset_id, o.customer_id, o.variant_id
    from replacement_case rc
    join "order" o on o.id = rc.order_id
    where rc.id = ${input.caseId}
      and rc.order_id = ${order.id}
    limit 1
    for update of rc
  `.execute(exec);
  const row = existing.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu thay thế." };

  if (row.status === "REPLACED" && row.replacement_asset_id) {
    const issued = await issueReplacementDeliveryBundleInTransaction(exec, {
      orderId: row.order_id,
      customerId: row.customer_id,
      assetId: row.replacement_asset_id,
      ttlSeconds: input.bundleTtlSeconds,
      correlationId: input.correlationId,
      ...(input.deliveryTokenKeys ? { deliveryTokenKeys: input.deliveryTokenKeys } : {}),
    });
    if (!issued.ok) return { ok: false, code: "DELIVERY_FAILED", message: issued.message };
    return {
      ok: true,
      caseId: row.case_id,
      orderId: row.order_id,
      customerId: row.customer_id,
      replacementAssetId: row.replacement_asset_id,
      bundleId: issued.bundleId,
      token: issued.token,
      reused: true,
    };
  }

  if (row.status !== "OPEN" && row.status !== "APPROVED") {
    return { ok: false, code: "NOT_ELIGIBLE", message: "Yêu cầu thay thế không còn chờ duyệt." };
  }

  const fulfilledSibling = await sql<{ case_id: string; replacement_asset_id: string }>`
    select id as case_id, replacement_asset_id
    from replacement_case
    where order_id = ${row.order_id}
      and original_asset_id = ${row.original_asset_id}
      and status = 'REPLACED'
      and replacement_asset_id is not null
      and id <> ${row.case_id}
    order by resolved_at asc nulls last, opened_at asc, id asc
    limit 1
    for update
  `.execute(exec);
  const sibling = fulfilledSibling.rows[0];
  if (sibling) {
    await sql`
      update replacement_case
      set status = 'REPLACED', replacement_asset_id = ${sibling.replacement_asset_id}, resolved_at = now()
      where id = ${row.case_id}
    `.execute(exec);
    const issued = await issueReplacementDeliveryBundleInTransaction(exec, {
      orderId: row.order_id,
      customerId: row.customer_id,
      assetId: sibling.replacement_asset_id,
      ttlSeconds: input.bundleTtlSeconds,
      correlationId: input.correlationId,
      ...(input.deliveryTokenKeys ? { deliveryTokenKeys: input.deliveryTokenKeys } : {}),
    });
    if (!issued.ok) return { ok: false, code: "DELIVERY_FAILED", message: issued.message };
    return {
      ok: true,
      caseId: row.case_id,
      orderId: row.order_id,
      customerId: row.customer_id,
      replacementAssetId: sibling.replacement_asset_id,
      bundleId: issued.bundleId,
      token: issued.token,
      reused: true,
    };
  }

  const stockCandidate = await sql<{ id: string; version: number }>`
    select id, version
    from digital_asset
    where variant_id = ${row.variant_id}
      and status = 'AVAILABLE'
    order by created_at asc, id asc
    limit 1
    for update skip locked
  `.execute(exec);
  const asset = stockCandidate.rows[0];
  if (!asset)
    return { ok: false, code: "OUT_OF_STOCK", message: "Không còn tài khoản thay thế khả dụng." };

  const updated = await sql`
    update digital_asset
    set status = 'RESERVED',
        reserved_order_id = ${row.order_id},
        reserved_until = now() + (${input.bundleTtlSeconds} || ' seconds')::interval,
        version = version + 1,
        updated_at = now()
    where id = ${asset.id} and version = ${asset.version} and status = 'AVAILABLE'
  `.execute(exec);
  if (Number(updated.numAffectedRows ?? 0) < 1)
    return { ok: false, code: "OUT_OF_STOCK", message: "Tài khoản thay thế vừa được dùng." };

  await sql`
    update replacement_case
    set status = 'REPLACED', replacement_asset_id = ${asset.id}, resolved_at = now()
    where id = ${row.case_id}
  `.execute(exec);

  await sql`
    update delivery_bundle
    set status = 'REVOKED', revoked_at = now(), version = version + 1
    where order_id = ${row.order_id}
      and asset_id <> ${asset.id}
      and status in ('CREATED','AVAILABLE','VIEWED')
  `.execute(exec);

  const issued = await issueReplacementDeliveryBundleInTransaction(exec, {
    orderId: row.order_id,
    customerId: row.customer_id,
    assetId: asset.id,
    ttlSeconds: input.bundleTtlSeconds,
    correlationId: input.correlationId,
    ...(input.deliveryTokenKeys ? { deliveryTokenKeys: input.deliveryTokenKeys } : {}),
  });
  if (!issued.ok) return { ok: false, code: "DELIVERY_FAILED", message: issued.message };

  return {
    ok: true,
    caseId: row.case_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    replacementAssetId: asset.id,
    bundleId: issued.bundleId,
    token: issued.token,
    reused: issued.reused,
  };
}
